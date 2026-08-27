/**
 * CSP 违规上报（仅开发环境）。
 *
 * CSP 的失败模式通常是**静默的**：某个资源被拦掉，功能悄悄不工作，控制台里
 * 那条 "Refused to..." 又容易被其它日志淹没。冒烟测试靠肉眼看很不可靠，
 * 所以这里挂一个监听器把违规集中、显眼地打出来，并存到
 * `window.__cspViolations` 便于测完一次性回看。
 *
 * 只在 dev 生效：生产环境不需要这份噪音，真实违规应通过 report-to 收集。
 */

export interface CspViolation {
  directive: string;
  blockedURI: string;
  source: string;
  sample: string;
}

export function installCspViolationReporter(): void {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env?.DEV !== true) return;

  const violations: CspViolation[] = [];
  (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations =
    violations;

  document.addEventListener("securitypolicyviolation", (e) => {
    const v: CspViolation = {
      // effectiveDirective 才是真正拦下它的指令；violatedDirective 已废弃
      directive: e.effectiveDirective || e.violatedDirective,
      blockedURI: e.blockedURI,
      source: `${e.sourceFile ?? "?"}:${e.lineNumber ?? 0}`,
      sample: e.sample ?? "",
    };
    violations.push(v);
    console.error(
      `[CSP 违规 #${violations.length}] ${v.directive} 拦下了 ${v.blockedURI || "(inline)"}` +
        (v.sample ? `\n  片段: ${v.sample}` : "") +
        `\n  来源: ${v.source}` +
        `\n  → 冒烟结束后执行 window.__cspViolations 查看全部`,
      v,
    );
  });

  // 顺带把实际生效的策略打出来：Tauri 会在运行时往 style-src / script-src
  // 注入 nonce 与资源 hash，所以生效值与 tauri.conf.json 里写的并不相同。
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy"]',
  );
  console.info(
    "[CSP] 生效策略:",
    meta?.content ?? "(未找到 meta，可能仅通过响应头下发)",
  );
}
