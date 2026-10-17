import { exampleWebPlugin } from "@zenorm/plugin-example/web";
import { createWebApp } from "@zenorm/web/app";

// After the app's own stylesheet, so this complete one (web's and the plugin's sources) is last.
import "./index.css";

// The example composition: the web with the example plugin, as the server composes it.
createWebApp({ plugins: [exampleWebPlugin] });
