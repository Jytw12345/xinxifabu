/* ============================================================
 * config.js  —  设计需求发布平台 全局配置
 * 复用「设计部工作台」同一套 Supabase 项目（东京），
 * 因此用户体系（auth.users）与工作台完全互通：工作台设计师用同一邮箱登录即可在平台抢单。
 * ============================================================ */
window.Cfg = (function () {
  // 与 sheji-main/js/config.js 完全一致：同一项目、同一 anon key（公开安全，靠 RLS + Auth 保护）
  const SUPABASE_URL = 'https://menfionjslkqzueyrteb.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_4jXSQSsr_qDFQeMiqJSCoA_YZy6sqsU';

  // 任务类型（与工作台保持一致，便于后续打通订单）
  const TASK_TYPES = ['名片', '画册', '展架', '喷绘', '标识', '文化墙', '展板', '门头', '设计', '排版', '其他'];

  // 需求状态展示（对外发布版本，文案尽量正式、中性）
  const STATUS = {
    open:           { label: '可接单',     color: '#2563eb' },
    locked:         { label: '已接单',     color: '#d97706' },
    in_progress:    { label: '设计中',     color: '#8b5cf6' },
    cancel_request: { label: '取消申请中', color: '#be123c' },
    done:           { label: '已完成',     color: '#15803d' },
    cancelled:      { label: '已关闭',     color: '#94a3b8' }
  };

  function normUrl(u) { return (u || '').trim().replace(/\/+$/, ''); }

  return { SUPABASE_URL, SUPABASE_ANON_KEY, TASK_TYPES, STATUS, normUrl };
})();
