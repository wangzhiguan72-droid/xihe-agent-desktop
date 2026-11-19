// 价格表（¥/百万 tokens）。来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 抓取日期 2026-09-27（页面动态渲染，须用抓正文的方式读，curl 直取拿不到数字）。
//
// DeepSeek 官方是**分时计价**：高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00 与 14:00–18:00；
// 其余时段（含周末与节假日全天）为空闲，价格是高峰的一半。所以每个模型给两组价：
//   { hit, miss, out }         = 空闲时段
//   { peak: {hit, miss, out} } = 高峰时段
// costOf 按调用时刻自动取组；只给一组价（第三方模型/用户自填）时两组都用它。
//
// v2.4 实测「界面估算偏高约 2.8×」（issues V-33）的根因就在这里：旧表把 deepseek-flash 的缓存
// 命中价写成 0.25（实际空闲 0.02 / 高峰 0.04）。这个工作负载刻意做前缀缓存，命中 token 占绝大多数，
// 于是命中部分被高估 6–12 倍，把总估算整体顶上去。实扣仍以账户余额差为准（server.js dsBalance）。
'use strict';

const DEFAULT_PRICES = {
  'deepseek-flash': { hit: 0.02, miss: 1.0, out: 4.0, peak: { hit: 0.04, miss: 2.0, out: 8.0 } },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5, peak: { hit: 0.30, miss: 9.0, out: 27.0 } },
  // 视觉桥/第三方：默认不计费（用量单独计数）；要计费在设置里按各家价目表填
  'glm-5.3-flash': { hit: 0, miss: 0, out: 0 },
  'glm-4.6v': { hit: 0, miss: 0, out: 0 },
};

// 北京时间高峰时段判定（周一至周五 9–12、14–18）。法定节假日不单独处理——表里没有节假日日历，
// 宁可把节假日按高峰计价（估高不估低，配合日预算熔断更安全）。
function isPeak(at = Date.now()) {
  const d = new Date(at + 8 * 3600e3); // UTC+8
  const day = d.getUTCDay();            // 0=周日
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function priceFor(model, prices, at) {
  const p = (prices && prices[model]) || DEFAULT_PRICES[model] || { hit: 2, miss: 2, out: 8 };
  if (p.peak && isPeak(at)) return p.peak;
  return p;
}

function costOf(model, usage, prices, at) {
  const p = priceFor(model, prices, at);
  const hit = Math.max(0, usage.cache_hit_tokens || 0);
  // 未命中 = 总输入 - 缓存读（下限 0，防计量口径差异导致负费用）
  const miss = Math.max(0, (usage.prompt_tokens || 0) - hit);
  const out = usage.completion_tokens || 0;
  return (hit * p.hit + miss * p.miss + out * p.out) / 1e6;
}

module.exports = { DEFAULT_PRICES, costOf, isPeak, priceFor };
