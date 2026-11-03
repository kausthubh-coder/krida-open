import { describe, expect, test } from "vitest";
import { downloadsIn } from "../src/features/landing/releases";

const asset = (tag: string, name: string) => ({ name, browser_download_url: `https://github.com/kausthubh-coder/krida-open-releases/releases/download/${tag}/${name}` });

describe("the landing page's downloads", () => {
  test("each app gets its newest file, though Android's release is never the repo's latest", () => {
    const releases = [
      { tag_name: "android-v1.4.0", assets: [asset("android-v1.4.0", "Krida-1.4.apk")] },
      {
        tag_name: "desktop-v0.1.10",
        assets: [
          asset("desktop-v0.1.10", "Krida_0.1.10_aarch64.app.tar.gz"),
          asset("desktop-v0.1.10", "Krida_0.1.10_aarch64.app.tar.gz.sig"),
          asset("desktop-v0.1.10", "Krida_0.1.10_aarch64.dmg"),
          asset("desktop-v0.1.10", "latest.json"),
        ],
      },
      { tag_name: "android-v1.3.0", assets: [asset("android-v1.3.0", "Krida-1.3.apk")] },
    ];
    expect(downloadsIn(releases)).toEqual({
      android: "https://github.com/kausthubh-coder/krida-open-releases/releases/download/android-v1.4.0/Krida-1.4.apk",
      mac: "https://github.com/kausthubh-coder/krida-open-releases/releases/download/desktop-v0.1.10/Krida_0.1.10_aarch64.dmg",
    });
  });

  test("Windows shows once a release carries its installer, never its signature", () => {
    const releases = [{ assets: [asset("desktop-v0.1.11", "Krida_0.1.11_x64-setup.exe.sig"), asset("desktop-v0.1.11", "Krida_0.1.11_x64-setup.exe")] }];
    expect(downloadsIn(releases)).toEqual({ windows: "https://github.com/kausthubh-coder/krida-open-releases/releases/download/desktop-v0.1.11/Krida_0.1.11_x64-setup.exe" });
  });

  test("drafts, pre-releases and an answer that isn't a list offer nothing", () => {
    expect(downloadsIn([{ draft: true, assets: [asset("a", "Krida.apk")] }, { prerelease: true, assets: [asset("b", "Krida.dmg")] }])).toEqual({});
    expect(downloadsIn({ message: "Not Found" })).toEqual({});
  });
});
