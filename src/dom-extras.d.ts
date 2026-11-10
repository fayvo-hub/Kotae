// TypeScript 7 的 lib.dom.d.ts 把 CSS Custom Highlight API 的成员写漏了：
// 运行时 Highlight 是 Set<AbstractRange>、HighlightRegistry 是 Map<string, Highlight>，
// 规范与 Chromium 都提供 add / clear / set / delete / get，而库里只留了 forEach。
// 这里按规范补齐签名，只影响类型检查（codeEditor.ts 用高亮 API 着色）。

interface Highlight {
  add(range: AbstractRange): this;
  clear(): void;
  delete(range: AbstractRange): boolean;
}

interface HighlightRegistry {
  set(name: string, value: Highlight): this;
  get(name: string): Highlight | undefined;
  delete(name: string): boolean;
  clear(): void;
}
