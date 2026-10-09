import { render } from "preact";
import { TvApp } from "./app.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("the TV page has no #root to render into");
render(<TvApp />, root);
