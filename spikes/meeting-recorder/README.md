# Meeting recorder device QA

`MEETING_RECORDER_QA=1` makes Metro serve this screen instead of the app. It
drives the real native recorder, capture journal and Android notification
controls without pairing a server, and logs one `MEETING_QA` line per second to
logcat (`ReactNativeJS`). Use it with an installed development build:

```sh
MEETING_RECORDER_QA=1 EXPO_NO_DOTENV=1 npx expo start --dev-client --port 8081
adb reverse tcp:8081 tcp:8081
```

Nothing is uploaded; recordings stay in the app's document directory.
