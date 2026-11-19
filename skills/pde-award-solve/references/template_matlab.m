% 获奖级 PDE 求解骨架（MATLAB / ode15s）——pde-award-solve 技能附带模板
% 适用：球/柱对称扩散-反应、传热传质、移动（收缩）边界。
% 含：守恒型有限体积 + 表面加密网格 + ode15s(RelTol=1e-9, MaxStep=10, JPattern)
%     + Events 精确下穿 + 双口径终点 + 守恒审计。
% 用法：复制到 scripts/ 下改方程与参数；先 SMOKE=true 冒烟（n=51, T_END=600），再放大正式跑。
% 运行：matlab -batch "run('scripts/qN_solve.m')"
%
% 关键设计（与同目录 template_scipy.py 一一对应，别只改一边）：
%   1) 每个控制体的进出面通量成对出现（i 的右面 = i+1 的左面）——守恒型离散；
%   2) 表面用 Robin：−D·∂u/∂r|_R = h·(u_R − u_amb)，所以面通量 F_R = −h·(u_R − u_amb)。
%      **这个负号不能省**：写成 +h(…) 表面会反向暴涨，守恒审计同时报 100% 残差；
%   3) h 必须与 D 同量纲（m/s）。手上是换热系数 W/(m²·K) 就先除以 ρ·cp 换算，
%      否则表面节点时间常数从「秒」掉到「纳秒」，ode15s 直接 overflow。

clear; clc;

SMOKE  = true;                        % 冒烟开关
NGRID  = 51;    if ~SMOKE, NGRID = 1281; end
T_END  = 600;   if ~SMOKE, T_END = 24*3600; end
Level  = 0.10;                        % 判停阈值（与 u 同量纲）
R0     = 2.0e-2;                      % 初始半径 [m]
Dcoef  = 7e-9;                        % 扩散系数 [m^2/s]
Hconv  = 1.0e-5;                      % 表面对流系数 [m/s]（与 D 同量纲！）
Uamb   = 0.05;                        % 环境值
Uinit  = 0.35;                        % 初值（均匀场）

% ---- 表面加密网格：r = R(1-(1-xi)^2)，表面附近格距最小 ----
xi = linspace(0, 1, NGRID);
r  = R0 * (1 - (1 - xi).^2);
r  = r(:);                            % 必须列向量：行向量与 y(列) 做 ./ 会广播成矩阵
rL = zeros(NGRID, 1); rR = zeros(NGRID, 1);
rL(1) = 0;                            % 中心对称面
rL(2:end) = (r(1:end-1) + r(2:end)) / 2;
rR(1:end-1) = rL(2:end);              % i 的右面 = i+1 的左面（成对）
rR(end) = r(end);                     % 表面

V = (rR.^3 - rL.^3) / 3;              % 控制体体积（4π 已约掉）

y0 = Uinit * ones(NGRID, 1);

% ---- 稀疏雅可比结构（三对角）——ode15s 靠它把雅可比构造降到 O(n) ----
e = ones(NGRID, 1);
JPattern = spdiags([e e e], -1:1, NGRID, NGRID);

opts = odeset('RelTol', 1e-9, 'AbsTol', 1e-12, 'MaxStep', 10, ...
              'JPattern', JPattern, 'Vectorized', 'off', ...
              'Events', @(t,y) eventCross(y, Level));

odef = @(t,y) rhs(y, r, rL, rR, V, Dcoef, Hconv, Uamb);

Tc = NaN; Tok = NaN;
sol = ode15s(odef, [0 T_END], y0, opts);
if ~isempty(sol.xe) && ~isnan(sol.xe(1))
    Tc  = sol.xe(1);                  % 连续口径：精确下穿时刻
    Tok = floor(Tc) + 1;              % 首严格达标整秒
    % 验证前一秒不达标（双口径的严谨性）
    s2 = ode15s(odef, [max(Tc-1,0) Tok], sol.ye(:,1), opts);
    prevOK = min(s2.y(:,end)) >= Level;
    fprintf('[终点] 连续口径 tc=%.6f s；首严格达标整秒 t_ok=%.1f s（前一秒不达标=%d）\n', Tc, Tok, ~prevOK);
end

% ---- 守恒审计：Σu·V 初末差 vs 表面 Robin 通量时间积分 ----
Yall = deval(sol, sol.x);                       % NGRID × NT
ini  = sum(Yall(:,1)  .* V);
fin  = sum(Yall(:,end) .* V);
surf = Hconv * (Yall(end,:)' - Uamb) * r(end)^2; % 表面通量 × 面积因子（向外为正）
flux = trapz(sol.x, surf);
rel  = abs((fin - ini) - (-flux)) / max([abs(fin-ini), abs(flux), 1e-12]);
fprintf('[守恒] 初值=%.10e 末值=%.10e 表面通量积分(流入为正)=%.10e 相对误差=%.4f%%\n', ini, fin, -flux, rel*100);
fprintf('[网格] 节点=%d 表面格距=%.3e 中心格距=%.3e\n', NGRID, r(end)-r(end-1), r(2)-r(1));
fprintf('[输出] 末态中心=%.4f 表面=%.4f 连续口径终点=%s\n', Yall(1,end), Yall(end,end), ternary(isnan(Tc), '未触发', sprintf('%.6fs', Tc)));

% 把 ini/fin/flux 三个数拿去 conservation_check 登记（引擎自己复算残差）：
%   conservation_check({op:"register", question:N, quantity:"...", initial:ini, final:fin,
%                       boundary_flux:-flux, run_id:"runN"})
% 网格收敛：NGRID 取 161/641/1281 各跑一次，比关键输出差值/收敛阶，写进备注。
% 情景灵敏度：边界延拓改「末段均值」再跑一次，差值写进结果与论文检验节。

function dydt = rhs(y, r, rL, rR, V, Dcoef, h, uamb)
% 守恒型有限体积（球对称）：∂u/∂t = (A_R·F_R − A_L·F_L)/V，F 为 +r 方向通量。
    n = numel(y);
    FR = zeros(n,1); FL = zeros(n,1);
    FL(1) = 0;                                          % 中心对称：通量 0
    FL(2:end) = Dcoef * (y(2:end) - y(1:end-1)) ./ (r(2:end) - r(1:end-1));
    FR(1:end-1) = FL(2:end);                            % 成对（守恒关键）
    FR(end) = -h * (y(end) - uamb);                     % 表面 Robin（负号不可省）
    dydt = (FR .* rR.^2 - FL .* rL.^2) ./ V;
end

function [value, isterminal, direction] = eventCross(y, level)
    value      = min(y) - level;                        % 下穿 level 时触发
    isterminal = 1;
    direction  = -1;
end

function out = ternary(cond, a, b)
    if cond, out = a; else, out = b; end
end
