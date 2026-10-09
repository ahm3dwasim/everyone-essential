import { render } from "preact";
import { PhoneApp } from "./app.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("the phone page has no #root to render into");
render(<PhoneApp />, root);
