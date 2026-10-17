import { describe, expect, test } from "vitest";

import { publishedReadme } from "./readme.ts";

const RAW = "https://raw.githubusercontent.com/Ze-Norm/ZeNorm/v1.2.3";
const BLOB = "https://github.com/Ze-Norm/ZeNorm/blob/v1.2.3";

describe("publishedReadme", () => {
  test("puts relative images on raw.githubusercontent.com at the ref", () => {
    expect(publishedReadme("![A demo](.github/assets/demo.gif)", "v1.2.3")).toBe(
      `![A demo](${RAW}/.github/assets/demo.gif)`,
    );
    expect(
      publishedReadme(
        '<source srcset=".github/assets/banner-dark.png" />\n<img alt="ZeNorm" src="./.github/assets/banner-light.png" />',
        "v1.2.3",
      ),
    ).toBe(
      `<source srcset="${RAW}/.github/assets/banner-dark.png" />\n<img alt="ZeNorm" src="${RAW}/.github/assets/banner-light.png" />`,
    );
  });

  test("puts other relative links on github.com at the ref, keeping fragments", () => {
    expect(
      publishedReadme(
        "[Setup](SETUP.md) · [plugin](examples/plugin-example) [x](SETUP.md#config)",
        "v1.2.3",
      ),
    ).toBe(
      `[Setup](${BLOB}/SETUP.md) · [plugin](${BLOB}/examples/plugin-example) [x](${BLOB}/SETUP.md#config)`,
    );
  });

  test("rewrites a link wrapped around an absolute badge", () => {
    expect(
      publishedReadme(
        "[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)",
        "v1.2.3",
      ),
    ).toBe(`[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](${BLOB}/LICENSE)`);
  });

  test("leaves absolute links, fragments and site paths alone", () => {
    const readme =
      "[a](https://zenorm.com/#pro) [b](http://127.0.0.1:4310) [c](#setup) [d](/x) [e](mailto:a@b.c)";
    expect(publishedReadme(readme, "v1.2.3")).toBe(readme);
  });
});
