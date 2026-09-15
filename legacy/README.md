# 旧版：Python + FFmpeg

需要 [FFmpeg](https://ffmpeg.org/)。Windows 双击 `启动.bat`，或：

```bash
python -m pip install -r requirements.txt
python app.py
```

打开 http://127.0.0.1:8765 。

```bash
python splitter.py 成片.mp4 --layout clean --audio mute --name clip
python splitter.py 成片.mp4 --layout carousel --count 4 --name v
```
