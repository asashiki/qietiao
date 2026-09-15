# 切条 · Splicer for X

把视频或图片切成 X 横滑连环帖，或转成 Pixiv 动图。**全程在浏览器里处理，文件不上传。**

默认：**整段 + 去掉声音**。也可切成 2 / 3 / 4 份发 X 横滑。

![切条界面](docs/screenshot.jpg)

## 画质

| 档位 | 用途 |
|---|---|
| 原像素 | 尽量保持源分辨率，出 MP4 / PNG |
| X 投稿 | 按 X 的分辨率和宽高比限制 |
| Pixiv → 动图 | JPEG 连帧（うごイラ）。电脑版投稿点「选择多张图片」。上限 150 张 / 合计 30MB |
| Pixiv → GIF | 真 GIF。上限 16MB / 500 帧，256 色 |

X 时间线左下角标着 GIF 的，其实是无声循环 MP4。发 X 用原像素或 X 投稿即可。

## 运行

需要 Node 22+。

```bash
npm install
npm run dev
```

浏览器打开终端里提示的地址。导出文件名默认 `clip`，可自己改。

```bash
npm run build
npm run preview
npm test
```

## 旧版

`legacy/` 是原先的 Python + FFmpeg 本地服务（`python app.py`）。浏览器版不再需要 FFmpeg。
