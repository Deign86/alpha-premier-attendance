# Bundled Piper TTS Resources

Place the Piper executable and dependencies in `resources/piper/`:
- Windows: `piper.exe`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `piper_phonemize.dll`, `espeak-ng.dll`, `espeak-ng-data/`, and MSVC runtime DLLs (`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`, `msvcp140_codecvt_ids.dll`)
- Models: place `.onnx` and `.onnx.json` model files in `resources/piper/models/` (e.g. `en_US-lessac-medium.onnx` and `en_US-lessac-medium.onnx.json`).
