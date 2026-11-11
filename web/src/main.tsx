import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { queryClient } from "./runtime";
import "./theme.css";
import "./themes/punk-collage.css";
import { ACTIVE_UI_THEME, uiTheme } from "../../shared/src/ui-theme";
import { startAppUpdates } from "./app-updater";
import { configureKeyboardLayout } from "./visible-viewport";

configureKeyboardLayout();
document.documentElement.dataset.uiTheme = ACTIVE_UI_THEME;
document.querySelector('meta[name="theme-color"]')?.setAttribute("content", uiTheme.primary);
startAppUpdates();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
