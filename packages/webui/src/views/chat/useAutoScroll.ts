import { AgentNS } from "@ai-zen/agents-core";
import { nextTick, watch } from "vue";
import { debounce, nextFrame } from "../../utils";

export function useAutoScroll(options: {
  getScrollEl(): HTMLDivElement | null | undefined;
  getMessages(): AgentNS.Message[] | undefined;
}) {
  // 滚动到底部（带防抖）
  const scrollToBottomWithDebounce = debounce(async () => {
    await nextTick();
    await nextFrame();

    const scrollBarEl = options.getScrollEl();
    if (!scrollBarEl) return;

    scrollBarEl.scrollTo({ behavior: "smooth", top: scrollBarEl.scrollHeight });
  }, 100);

  // 任意消息内容变化触发滚动
  watch(
    () => options.getMessages(),
    () => {
      const scrollBarEl = options.getScrollEl();
      if (!scrollBarEl) return;

      // 判断渲染前是否处于底部，如果处于底部那么就在下一次渲染后滚动到底部
      if (
        scrollBarEl.scrollTop >=
        scrollBarEl.scrollHeight - scrollBarEl.clientHeight - 200
      ) {
        scrollToBottomWithDebounce();
      }
    },
    { deep: true }
  );
}
