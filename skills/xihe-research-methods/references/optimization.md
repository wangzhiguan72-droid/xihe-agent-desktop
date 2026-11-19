# 优化

## 什么时候适用

要在明确决策域和约束下选址、分配、排程、控制或搜索时使用。先分清平均、最坏、分位数、多目标或机会约束；换目标可能换答案。

## 最小基线

写出决策变量、域、目标、硬约束和单位。有限小问题优先完整枚举并回代可行性；规模较大可用可解释的可行规则/贪心作为基线，再按结构选择求解器。不要把本来能精确枚举的小题包装成昂贵启发式任务。

## 什么现象值得升级

先查可行域是否为空、基线在哪些约束或目标上存在缺口，再看求解规模、时间和可认证差距。候选差异超常时检查是否偷偷少了一条约束。目标系数、偏好或需求未知，先推导分界条件或可行范围，不能用未声明的点估计代替题面。

## 做什么检验

对最终方案逐条回代原约束，重算目标。完整枚举支持**声明的完整有限域内**最优；网格、短名单和截断搜索只能支持已查集合中的最佳值。记录求解状态、界、容差、间隙与时间限制；局部收敛或 FEASIBLE 不自动等于全局最优。若问题有凸性/对偶或解析证明，单独核验前提和证明。

羲和支持一类可实算的窄核验：若目标和全部硬约束能如实写成二次以内的数值多项式，先在 `model_spec.optimization.check` 登记 `direction:min|max`、变量有限域或区间、`objective:{constant?,terms:[{coefficient,powers}]}`、`constraints:[{polynomial,sense:le|ge|eq,rhs}]`。正式运行把 `optimization:{level,solution,objective,...}` 写入 `result_files` 声明的 JSON，并 `question_graph link_run`；再调用 `optimization_check({op:"check",question_id,run_id,path})`。`feasible` 只核可行与目标；`candidates` 核已查候选；`grid` 还核网格笛卡尔积完整；`finite_domain` 由宿主穷举登记有限域。上限是 8 变量、100 项、100 约束、10,000 个点。原句要写“可行”“候选内”“网格内”或“登记有限域内”，数值最优主张的 `claim_trace` 另填 `optimality:{level}`，直接绑定 `optimization.objective`；其 `scope` 必须逐字复制 `optimization_check` 返回的 `report.optimality_scope`，不可自由扩大。额外数据条件与假设记入模型规格和论文正文。`optimization_check view` 在提交前复核版本。

上述回代只检验登记模型。连续域最优、未登记硬约束、规模超限、求解器状态及一般证明没有因此获得认证；写不下真实模型时保留待核与正确的结论上限。无数值解的条件性解析路线按原有推导、前提和隔离核查回执登记，不把有限脚本测试称为通用证明。

不可行结论应来自可核对的约束矛盾/界或有效不可行证明。超时未找到方案、数值失败或 UNKNOWN 只是未决。声称提高收益时对基线和候选使用同约束、同输入、同预算及同指标。

## 检验失败后怎么办

硬约束冲突时指出冲突和最小缺口/必要条件，必要时报告可行性松弛分析供决策；不能把“建议修改约束”当作已经获得修改权限。目标或数据不足时给条件性推荐，说明补哪个量会改变方案。搜索没有最优证据时报告可行解与已知界，不夸大全局性。

## 依据与范围

- [OR-Tools 官方 CP-SAT 状态与全解枚举说明](https://developers.google.com/optimization/cp/cp_solver)：OPTIMAL、FEASIBLE、INFEASIBLE 与 UNKNOWN 的区别及有限域枚举。
- [Gurobi 官方状态表](https://docs.gurobi.com/projects/optimizer/en/current/reference/numericcodes/statuscodes.html)：最优状态以求解器容差为限，时间限制等状态须分别报告。

来源核对：2026-11-13。不指定必须使用上述软件；其它求解器按自身文档解释状态。
