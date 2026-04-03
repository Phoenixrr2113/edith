import { mount } from "svelte";
import App from "./App.svelte";
import "./styles/theme.css";
// Note: theme.svelte.ts is imported inside App.svelte

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount point");

const app = mount(App, { target });

export default app;
