import { createContext, useContext } from "react";
import type { PluginWindowInfo } from "../../../shared/plugin-windows";

export const PluginWindowContext = createContext<PluginWindowInfo | undefined>(undefined);
export const usePluginWindow = () => useContext(PluginWindowContext);
