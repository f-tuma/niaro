import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ScrollView, View } from "react-native";
import {
  MeetingRow,
  MeetingDetailView,
  MeetingNotice,
} from "../../packages/ui-catalog/MeetingView";
import {
  meetingFixture,
  meetingSegmentFixture,
  meetingRecordFixture,
} from "../../packages/test-fixtures/meeting";
import {
  HumanTaskActions,
  HumanTaskCard,
} from "../../packages/ui-catalog/HumanTaskView";
import { humanTaskFixture } from "../../packages/test-fixtures/human-task";
import { Button, Group, Stack, Text } from "../../packages/ui";
import { tokens } from "../../packages/design-tokens";
function App() {
  const [language, setLanguage] = useState<"en" | "cs">("en");
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(false);
  const [human, setHuman] = useState(humanTaskFixture);
  const [resolving, setResolving] = useState(false);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.color.background }}
      contentContainerStyle={{ padding: tokens.spacing.screenGutter }}
    >
      <View style={{ maxWidth: 520, width: "100%", alignSelf: "center" }}>
        <Stack>
          <Text role="screenTitle">Meetings QA</Text>
          <Button
            label={language === "en" ? "Česky" : "English"}
            variant="secondary"
            onPress={() => setLanguage(language === "en" ? "cs" : "en")}
          />
          <Group>
            <MeetingRow
              meeting={meetingFixture}
              language={language}
              onOpen={() => setOpen(true)}
            />
          </Group>
          {open ? (
            <MeetingDetailView
              record={meetingRecordFixture}
              language={language}
              onSource={() => setSource(true)}
            />
          ) : null}
          {open ? (
            <Group>
              <HumanTaskCard
                task={human}
                language={language}
                // The app opens the task sheet; here it marks the item done.
                onMore={() =>
                  setHuman((task) => ({
                    ...task,
                    revision: task.revision + 1,
                    status: "done",
                    resolution: {
                      by: "user",
                      reason: "",
                      at: "2026-10-08T12:00:00.000Z",
                    },
                  }))
                }
              />
            </Group>
          ) : null}
          {open && human.status === "open" ? (
            <HumanTaskActions
              task={human}
              language={language}
              onResolve={() => setResolving(true)}
              onDecide={() => {}}
            />
          ) : null}
          {resolving ? (
            <MeetingNotice title="Resolve requested" hint={human.title} />
          ) : null}
          {source ? (
            <MeetingNotice
              title="Source selected 0:00"
              hint={meetingSegmentFixture.text}
            />
          ) : null}
        </Stack>
      </View>
    </ScrollView>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
