# 切条 · Splicer for X

默认：**整段重编码 + 去掉声音**。也可切成 2 / 3 / 4 份发 X 横滑。

![切条界面](docs/screenshot.jpg)

## 运行

需要 [FFmpeg](https://ffmpeg.org/)。Windows 双击 `启动.bat`，或：

```bash
python -m pip install -r requirements.txt
python app.py
```

打开 http://127.0.0.1:8765 。导出文件名默认 `clip`，可自己改。

```bash
python splitter.py 成片.mp4 --layout clean --audio mute --name clip
python splitter.py 成片.mp4 --layout carousel --count 4 --name v
```
