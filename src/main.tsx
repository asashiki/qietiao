import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QietiaoApp } from "@/components/qietiao-app";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QietiaoApp />
  </StrictMode>,
);
