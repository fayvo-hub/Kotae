// Cookie 管理器：查看、逐条删除、整体清空当前 Cookie 罐里的内容。
// 数据全部来自 Go 侧，这里只负责展示与操作。

import { System, type CookieRecord } from "../mygo";
import { closeAll, modal } from "./overlays";
import { el, fill, icon } from "./dom";
import { toast } from "../store";

function formatExpires(ms: number): string {
  if (!ms) return "会话";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function matches(record: CookieRecord, keyword: string): boolean {
  if (!keyword) return true;
  const text = keyword.toLowerCase();
  return (
    record.name.toLowerCase().includes(text) ||
    record.domain.toLowerCase().includes(text) ||
    record.path.toLowerCase().includes(text)
  );
}

/** 一行 Cookie：名字、值、路径、过期时间与删除按钮。 */
function cookieRow(record: CookieRecord, onDelete: () => void): HTMLElement {
  const flags: string[] = [];
  if (record.hostOnly) flags.push("仅此域名");
  if (record.secure) flags.push("Secure");
  if (record.httpOnly) flags.push("HttpOnly");
  const row = el("div", { class: "cookie-row" });
  row.append(
    el(
      "div",
      { class: "cookie-main" },
      el("span", { class: "cookie-name", text: record.name }),
      el("span", { class: "cookie-value", text: record.value || "（空值）" }),
    ),
    el(
      "div",
      { class: "cookie-meta" },
      el("span", { text: `路径 ${record.path}` }),
      el("span", { text: `过期 ${formatExpires(record.expires)}` }),
      ...(flags.length ? [el("span", { text: flags.join(" · ") })] : []),
    ),
    el(
      "button",
      {
        class: "icon-btn",
        attr: { type: "button", title: "删除这条 Cookie", "aria-label": "删除这条 Cookie" },
        on: { click: onDelete },
      },
      icon("trash"),
    ),
  );
  return row;
}

/** Cookie 列表本体：筛选框 + 按域名分组 + 清空全部。 */
export function cookieList(): HTMLElement {
  const wrap = el("div", { class: "cookie-manager" });
  const search = el("input", {
    class: "text-input cookie-search",
    attr: { type: "search", placeholder: "筛选域名、名字或路径", "aria-label": "筛选 Cookie" },
  });
  const count = el("span", { class: "muted small cookie-count" });
  const clear = el("button", {
    class: "btn small danger",
    attr: { type: "button" },
    text: "清空全部",
  });
  wrap.append(
    el("div", { class: "pane-toolbar" }, search, el("span", { class: "spacer" }), count, clear),
  );

  const list = el("div", { class: "cookie-list" });
  let records: CookieRecord[] = [];

  const render = (): void => {
    fill(list);
    const keyword = search.value.trim();
    const visible = records.filter((r) => matches(r, keyword));
    count.textContent = keyword ? `${visible.length} / ${records.length} 条` : `${records.length} 条`;
    if (!visible.length) {
      list.append(
        el("div", {
          class: "pane-empty",
          text: records.length ? "没有匹配的 Cookie" : "还没有 Cookie。发一次带 Set-Cookie 的请求就会出现。",
        }),
      );
      return;
    }
    let currentDomain = "";
    for (const record of visible) {
      if (record.domain !== currentDomain) {
        currentDomain = record.domain;
        list.append(el("div", { class: "cookie-domain", text: currentDomain }));
      }
      list.append(
        cookieRow(record, () => {
          void System.deleteCookie(record.name, record.domain, record.path).then(() => {
            records = records.filter(
              (r) => !(r.name === record.name && r.domain === record.domain && r.path === record.path),
            );
            render();
          });
        }),
      );
    }
  };

  const paint = async (): Promise<void> => {
    try {
      records = await System.cookies();
    } catch (err) {
      records = [];
      toast(`读取 Cookie 失败：${(err as Error).message}`, "error");
    }
    render();
  };

  search.addEventListener("input", render);
  clear.addEventListener("click", () => {
    if (!records.length) {
      toast("现在没有 Cookie");
      return;
    }
    void System.clearCookies().then(() => {
      toast("已清空 Cookie");
      void paint();
    });
  });
  wrap.append(list);
  void paint();
  return wrap;
}

/** 打开 Cookie 管理器；入口在「选项」页签与命令面板。 */
export function cookieDialog(): HTMLElement {
  const body = el("div", { class: "cookie-manager-body" });
  body.append(cookieList());
  body.append(
    el("p", {
      class: "pane-hint",
      text: "Cookie 由 Go 侧的 Cookie 罐保存，多条请求之间共享；在这里删掉的条目不会再被发送。",
    }),
  );
  const foot = el("div", { class: "dialog-foot" });
  const done = el("button", { class: "btn primary", attr: { type: "button" }, text: "完成" });
  done.addEventListener("click", () => closeAll());
  foot.append(done);
  return modal("Cookie 管理器", body, foot, 720);
}
