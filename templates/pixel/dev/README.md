# cm-pixel.html 构建工具

`cm-pixel.html` 由 `template.html` + Kenney CC0 素材表自动生成——不要直接改 cm-pixel.html，改模板后重新构建。

## 构建

```bash
python3 build.py   # 需要 Pillow；先把脚本里的路径改成本目录
```

build.py 从三张素材表抠出用到的 tile 打成一张小图集（约 5KB），
以 base64 内嵌进模板的 @B64@ 占位符，tile 名称坐标表内嵌进 @TMAP@。

## 素材来源（全部 CC0，可商用）

- sheets/roguelikeIndoor_transparent.png — Kenney "Roguelike Indoors"
- sheets/roguelikeCity_tilemap.png — Kenney "Roguelike Modern City"
- sheets/roguelikeChar_transparent.png — Kenney "Roguelike Characters"（纸娃娃：身体+裤子+衣服+发型叠加）

下载页: https://kenney.nl/assets （CC0 1.0，无需署名）
