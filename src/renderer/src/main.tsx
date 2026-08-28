import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { App } from "./app/app";

// 终端组件的 effect 会创建真实 PTY；开发模式 StrictMode 的重复挂载会让同一会话短时间启动两次，
// Codex 会因此判定 JSONL 存在 active writer。Electron 渲染进程不启用 StrictMode，避免虚假重复启动。
createRoot(document.getElementById("root")!).render(<App />);
