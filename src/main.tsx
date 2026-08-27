import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { installCspViolationReporter } from "./utils/cspReport";

// 必须在渲染前挂载：渲染过程中就可能触发违规
installCspViolationReporter();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
