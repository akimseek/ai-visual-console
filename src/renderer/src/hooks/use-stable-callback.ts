import { useCallback, useEffect, useRef } from "react";

// 返回一个“身份恒定但始终调用最新实现”的回调，用于把处理函数传给 React.memo 子组件，
// 既避免每次渲染都换新函数引用（让 memo 失效），又不会捕获过期闭包（无需把一堆依赖列进 deps）。
// 等价于 React 实验性的 useEffectEvent，此处手写以保持稳定可用。
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
