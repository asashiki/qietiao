import json
import tempfile
import unittest
from pathlib import Path

import splitter as sp


def ffmpeg_ok() -> bool:
    try:
        sp.ffmpeg_bin()
        sp.ffprobe_bin()
        return True
    except sp.SplitError:
        return False


class TileMathTests(unittest.TestCase):
    def test_even(self):
        self.assertEqual(sp.even(1080), 1080)
        self.assertEqual(sp.even(1081), 1080)
        self.assertEqual(sp.even(1), 0)

    def test_carousel_1080p_four(self):
        info = sp.MediaInfo(
            path="x.mp4",
            kind="video",
            width=1920,
            height=1080,
            duration=6.0,
            fps=30.0,
            has_audio=True,
            video_codec="h264",
            audio_codec="aac",
            pix_fmt="yuv420p",
            rotation=0,
            sar="1:1",
            nb_frames=180,
            size_bytes=1,
        )
        plan = sp.plan_split(info, "carousel", 4, "keep")
        self.assertEqual(plan.cols, 4)
        self.assertEqual(plan.rows, 1)
        self.assertEqual(len(plan.tiles), 4)
        for tile in plan.tiles:
            self.assertEqual(tile.w, 480)
            self.assertEqual(tile.h, 1080)
            self.assertEqual(tile.out_w, 480)
            self.assertEqual(tile.out_h, 1080)
            self.assertTrue(tile.x_ok)
            self.assertFalse(tile.padded)
            self.assertFalse(tile.scaled)
        self.assertEqual([t.x for t in plan.tiles], [0, 480, 960, 1440])
        self.assertTrue(all(t.y == 0 for t in plan.tiles))
        self.assertEqual([t["label"] for t in plan.to_dict()["tiles"]], ["01", "02", "03", "04"])

    def test_grid_2x2(self):
        info = sp.MediaInfo(
            path="x.mp4",
            kind="video",
            width=1920,
            height=1080,
            duration=1.0,
            fps=30.0,
            has_audio=False,
            video_codec="h264",
            audio_codec=None,
            pix_fmt="yuv420p",
            rotation=0,
            sar="1:1",
            nb_frames=30,
            size_bytes=1,
        )
        plan = sp.plan_split(info, "grid", 4, "keep")
        self.assertEqual([(t.w, t.h) for t in plan.tiles], [(960, 540)] * 4)
        self.assertEqual([(t.col, t.row) for t in plan.tiles], [(0, 0), (1, 0), (0, 1), (1, 1)])

    def test_odd_source_center_crop(self):
        info = sp.MediaInfo(
            path="x.mp4",
            kind="video",
            width=1919,
            height=1080,
            duration=1.0,
            fps=24.0,
            has_audio=False,
            video_codec="h264",
            audio_codec=None,
            pix_fmt="yuv420p",
            rotation=0,
            sar="1:1",
            nb_frames=24,
            size_bytes=1,
        )
        plan = sp.plan_split(info, "carousel", 4, "keep")
        self.assertTrue(all(t.w % 2 == 0 and t.h % 2 == 0 for t in plan.tiles))
        self.assertEqual(plan.canvas_w, plan.tiles[0].w * 4)
        self.assertLessEqual(plan.canvas_w + plan.canvas_x, 1919)

    def test_suggest_portrait_stack(self):
        info = sp.MediaInfo(
            path="x.mp4",
            kind="video",
            width=1080,
            height=1920,
            duration=1.0,
            fps=30.0,
            has_audio=False,
            video_codec="h264",
            audio_codec=None,
            pix_fmt="yuv420p",
            rotation=0,
            sar="1:1",
            nb_frames=30,
            size_bytes=1,
        )
        layout, count = sp.suggest_layout(info)
        self.assertEqual(layout, "stack")
        self.assertEqual(count, 4)
        plan = sp.plan_split(info, layout, count, "keep")
        self.assertEqual(plan.tiles[0].w, 1080)
        self.assertEqual(plan.tiles[0].h, 480)
        self.assertTrue(all(t.x_ok for t in plan.tiles))

    def test_x_pad_too_skinny(self):
        # 4-col split of a tall 9:16 would be extremely skinny; pad in x profile.
        out_w, out_h, pad_w, pad_h, padded, scaled = sp.fit_x_dims(200, 1920)
        self.assertTrue(padded)
        self.assertGreaterEqual(out_w / out_h, sp.X_MIN_AR - 1e-6)
        self.assertEqual((out_w, out_h, pad_w, pad_h, padded, scaled)[4], True)

    def test_filter_complex_four_labels(self):
        info = sp.MediaInfo(
            path="x.mp4",
            kind="video",
            width=1280,
            height=720,
            duration=1.0,
            fps=30.0,
            has_audio=True,
            video_codec="h264",
            audio_codec="aac",
            pix_fmt="yuv420p",
            rotation=0,
            sar="1:1",
            nb_frames=30,
            size_bytes=1,
        )
        plan = sp.plan_split(info, "carousel", 4, "keep")
        fc = sp.build_filter_complex(plan)
        self.assertIn("split=4", fc)
        self.assertIn("[v0]", fc)
        self.assertIn("[v3]", fc)
        self.assertIn("crop=320:720:0:0", fc)
        self.assertIn("crop=320:720:960:0", fc)
        self.assertIn("format=yuv420p", fc)

    def test_safe_stem_keeps_cjk(self):
        self.assertIn("切条", sp._safe_stem("我的 切条 成片!!!"))


@unittest.skipUnless(ffmpeg_ok(), "ffmpeg not installed")
class FfmpegSplitTests(unittest.TestCase):
    def setUp(self):
        self._orig_encode = sp._video_encode_args

        def speedy(quality):
            return ["ultrafast" if x == "medium" else x for x in self._orig_encode(quality)]

        sp._video_encode_args = speedy

    def tearDown(self):
        sp._video_encode_args = self._orig_encode

    def _make_video(self, path: Path, w=1280, h=720, t=1.2) -> Path:
        cmd = [
            sp.ffmpeg_bin(),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={w}x{h}:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-t",
            str(t),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ]
        proc = sp.run_hidden(cmd, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return path

    def _dims(self, path: Path) -> tuple[int, int]:
        info = sp.probe(path)
        return info.width, info.height

    def test_probe_and_carousel_keep_pixels(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            src = self._make_video(root / "src.mp4", 1280, 720, 1.0)
            info = sp.probe(src)
            self.assertEqual((info.width, info.height), (1280, 720))
            self.assertEqual(info.kind, "video")
            self.assertTrue(info.has_audio)
            plan = sp.plan_split(info, "carousel", 4, "keep", "all")
            out = root / "out"
            files = sp.run_split(info, plan, out)
            self.assertEqual(len(files), 4)
            for f in files:
                self.assertEqual(self._dims(f), (320, 720))
                probed = sp.probe(f)
                self.assertEqual(probed.video_codec, "h264")
                self.assertEqual(probed.pix_fmt, "yuv420p")
                self.assertTrue(probed.has_audio)
            sidecar = (out / "投稿顺序.txt").read_text(encoding="utf-8")
            self.assertIn("01", sidecar)
            meta = json.loads((out / "split.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["plan"]["layout"], "carousel")

    def test_grid_dimensions(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            src = self._make_video(root / "src.mp4", 1280, 720, 0.8)
            info = sp.probe(src)
            plan = sp.plan_split(info, "grid", 4, "keep", "mute")
            files = sp.run_split(info, plan, root / "g")
            for f in files:
                self.assertEqual(self._dims(f), (640, 360))
                self.assertFalse(sp.probe(f).has_audio)

    def test_image_png_lossless_crop(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            src = root / "still.png"
            cmd = [
                sp.ffmpeg_bin(),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=1920x1080",
                "-frames:v",
                "1",
                str(src),
            ]
            proc = sp.run_hidden(cmd, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            info = sp.probe(src)
            self.assertEqual(info.kind, "image")
            plan = sp.plan_split(info, "carousel", 3, "keep")
            files = sp.run_split(info, plan, root / "i")
            self.assertEqual(len(files), 3)
            for f in files:
                self.assertEqual(f.suffix, ".png")
                self.assertEqual(self._dims(f), (640, 1080))

    def test_metadata_stripped(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            src = self._make_video(root / "src.mp4", 640, 360, 0.6)
            tagged = root / "tagged.mp4"
            cmd = [
                sp.ffmpeg_bin(),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(src),
                "-c",
                "copy",
                "-metadata",
                "comment=Signature: AAAAI_GENERATED",
                "-metadata",
                "artist=00000000-0000-0000-0000-000000000000",
                str(tagged),
            ]
            proc = sp.run_hidden(cmd, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            info = sp.probe(tagged)
            plan = sp.plan_split(info, "carousel", 2, "keep", "mute")
            files = sp.run_split(info, plan, root / "m")
            probe = [
                sp.ffprobe_bin(),
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                str(files[0]),
            ]
            out = sp.run_hidden(probe, capture_output=True, text=True)
            data = json.loads(out.stdout)
            tags = (data.get("format") or {}).get("tags") or {}
            blob = json.dumps(tags).lower()
            self.assertNotIn("signature", blob)
            self.assertNotIn("i_generated", blob)
            self.assertNotIn("00000000-0000-0000-0000-000000000000", blob)


if __name__ == "__main__":
    unittest.main()
