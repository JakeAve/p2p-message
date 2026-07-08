// client/ui/viewport.ts
// iOS Safari and older Android browsers don't shrink `100dvh` when the
// on-screen keyboard opens — the layout keeps its pre-keyboard height and
// the browser scrolls the page to keep the focused input visible, pushing
// the top of a fixed-height screen off-view. window.visualViewport tracks
// the actual visible area (including the keyboard), so mirror its height
// into a CSS var the layout can size against, and cancel the page scroll
// since the container now already fits the visible area exactly.
export function initViewportHeight(): void {
  const vv = globalThis.visualViewport;
  if (!vv) return;
  const sync = () => {
    document.documentElement.style.setProperty(
      "--app-height",
      `${vv.height}px`,
    );
    globalThis.scrollTo(0, 0);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
}
