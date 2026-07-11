/**
 * Shared chrome for every human-facing page this backend serves (OAuth callbacks, setup and
 * credential forms). People land on these from Slack in a fresh tab, so the small things carry
 * the UX: URLs inside provider instructions must be real links, long values must copy in one
 * click, a rejected form must offer a way back, and terminal success pages should try to close
 * their own tab.
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Escapes, then turns bare https URLs into links that open in a new tab. */
export function linkifyHtml(value: string): string {
  return escapeHtml(value).replace(
    /https:\/\/[^\s<>"']+[^\s<>"'.,)!?]/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

/** A code value with a one-click copy button (clipboard API, plus select-on-click fallback). */
export function copyableValue(value: string): string {
  const escaped = escapeHtml(value);
  return `<span class="copyable"><code onclick="getSelection().selectAllChildren(this)">${escaped}</code><button type="button" class="copy" data-copy="${escaped}" onclick="navigator.clipboard.writeText(this.dataset.copy).then(()=>{this.textContent='Copied';setTimeout(()=>{this.textContent='Copy'},1500)})">Copy</button></span>`;
}

export const pageStyles =
  "body{font:16px system-ui;background:#f7f7f8;margin:0}" +
  "main{max-width:620px;margin:8vh auto;background:#fff;padding:32px;border-radius:14px;box-shadow:0 8px 32px #0001}" +
  "label{display:block;margin:18px 0;font-weight:600}" +
  "input{box-sizing:border-box;width:100%;padding:11px;margin-top:6px}" +
  ".confirm input{width:auto}" +
  "small{display:block;font-weight:400;color:#555;margin-top:4px}" +
  "button{padding:12px 18px;background:#4a154b;color:#fff;border:0;border-radius:8px;cursor:pointer}" +
  "code{word-break:break-all;background:#eee;padding:2px 5px;cursor:pointer}" +
  ".copyable{display:inline-flex;align-items:center;gap:8px;max-width:100%}" +
  "button.copy{padding:4px 10px;font-size:13px;flex:none}" +
  "button.back{background:#616061}" +
  ".dim{color:#777;font-size:14px}" +
  "a{color:#1264a3}";

export function renderPage(
  title: string,
  bodyHtml: string,
  options: { autoCloseSeconds?: number; backButton?: boolean } = {}
): string {
  const back = options.backButton
    ? `<p><button type="button" class="back" onclick="history.back()">← Go back and fix it</button></p>`
    : "";
  const close = options.autoCloseSeconds
    ? `<p class="dim">This tab will close itself in ${options.autoCloseSeconds} seconds — or close it now and return to Slack.</p>` +
      `<script>setTimeout(function(){window.close()},${options.autoCloseSeconds * 1000})</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${pageStyles}</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}${back}${close}</main></body></html>`;
}
