# public/fonts — vendor 字体清单

平板端阅读字体（TABLET_DESIGN.md §5）。这些文件由开发者手动放入本目录，
不提交进 git 也可——但若要打入 release 包必须存在。

## 需要放入的文件

| 文件名 | 体积 (≈) | 字族名 (CSS) | 用途 |
|---|---|---|---|
| `SourceHanSerifSC-Regular.woff2` | 2.5 MB | `Source Han Serif SC` | 中文宋体（推荐 PDF / 长文阅读） |
| `SourceHanSansSC-Regular.woff2` | 2.3 MB | `Source Han Sans SC` | 中文黑体（界面 + EPUB） |
| `LXGWWenKai-Regular.woff2` | 5.0 MB | `LXGW WenKai` | 霞鹜文楷（社区顶流，中英混排极佳） |
| `LXGWNeoXiHei-Regular.woff2` | 4.5 MB | `LXGW Neo XiHei` | 霞鹜新晰黑（屏幕优化无衬线） |
| `Inter-Regular.woff2` | 200 KB | `Inter` | 英文界面 / UI 默认 |
| `CrimsonPro-Regular.woff2` | 400 KB | `Crimson Pro` | 英文衬线（长文阅读） |

**总计约 15 MB**。

## LICENSE（必须）

所有字体均为 SIL Open Font License 1.1，**vendor 须同时附 LICENSE**：

- `LICENSE-OFL-SourceHan.txt` —— 适用 Source Han Serif/Sans SC
- `LICENSE-OFL-LXGW.txt` —— 适用 LXGW WenKai / LXGW Neo XiHei
- `LICENSE-OFL-Inter.txt` —— 适用 Inter
- `LICENSE-OFL-CrimsonPro.txt` —— 适用 Crimson Pro

任何字体放进来时把它的 LICENSE 也一并放进来。

## 文件来源（参考）

- **Source Han Serif / Sans SC**：<https://github.com/adobe-fonts/source-han-serif> / `source-han-sans`
- **LXGW WenKai**：<https://github.com/lxgw/LxgwWenKai>
- **LXGW Neo XiHei**：<https://github.com/lxgw/LxgwNeoXiHei>
- **Inter**：<https://github.com/rsms/inter>
- **Crimson Pro**：<https://fonts.google.com/specimen/Crimson+Pro>

完整 CJK 字库通常 8-10 MB 一个，本目录列的 WOFF2 是 subset 版本——
若仓库找不到 subset，可用 `pyftsubset` 或 `cn-font-split` 自己 subset：
```
pyftsubset SourceHanSerifSC-Regular.otf \
  --unicodes-file=cjk-ext.txt \
  --flavor=woff2 \
  --output-file=SourceHanSerifSC-Regular.woff2
```

## 兼容回退

文件缺失时 `font-display: swap` 让浏览器回退到 font-family 列表的下一项
（系统的 Noto / PingFang / Microsoft YaHei）。用户不会看到空白页，只是没有
应用所选字体。`fontLoader.ts` 也不会因 404 抛错。
