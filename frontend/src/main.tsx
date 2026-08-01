import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ClerkProviderWrapper } from "@/providers/ClerkProviderWrapper";
import { QueryProvider } from "@/providers/QueryProvider";
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ClerkProviderWrapper>
        <QueryProvider>
          <App />
        </QueryProvider>
      </ClerkProviderWrapper>
    </BrowserRouter>
  </React.StrictMode>
);
