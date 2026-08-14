import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// 将 React 应用挂载到 index.html 提供的根节点。
createRoot(document.getElementById("root")).render(
  <App />,
);
