# foliate-js (readest fork)

This directory ships the JavaScript runtime of [foliate-js](https://github.com/johnfactotum/foliate-js)
in the variant maintained by the [readest](https://github.com/readest/readest) project.

* Upstream: <https://github.com/johnfactotum/foliate-js>
* Fork tracked: <https://github.com/readest/foliate-js>
* License: MIT (see `LICENSE` — Copyright (c) 2022 John Factotum)

The readest fork adds a true multi-view continuous-scroll paginator (lazy
loading of adjacent sections, primary view detection, fixed-layout / PDF
spread upgrades) on top of the upstream API. We pull the scripts as a
vendored dependency rather than via npm because the project is published
without a tagged release. To refresh:

```powershell
git -c http.proxy=http://127.0.0.1:7898 clone --depth=1 `
    https://github.com/readest/foliate-js.git D:\tmp\readest-foliate
Copy-Item D:\tmp\readest-foliate\*.js .\public\vendor\foliate-js\ -Force
```

Files originating from this fork retain the upstream MIT header where
present. Modifications local to `doc-reader` (if any) live in this
directory and are noted at the top of the affected file.

## Local patches

Tracked patches that must be re-applied after every refresh. Each one is
marked in source with a `doc-reader local patch:` comment so it stays
visible during merges.

- `paginator.js`: hide native scrollbar in `flow="scrolled"` mode
  (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }` on
  `:host([flow="scrolled"]) #container`). Keep the container scrollable
  but invisible — the right-side scrollbar visually conflicts with the
  reading layout in our shell.
