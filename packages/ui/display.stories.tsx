import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { Chip, IconTile, Row, Stack, StatusPill, Text } from "./index";
import { Tabs } from "./Tabs";
function Display() {
  const [tab, setTab] = useState<"waiting" | "active" | "done">("waiting");
  return (
    <Stack style={{ padding: 20, gap: 20 }}>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "waiting", label: "Waiting", count: 2 },
          { id: "active", label: "Active" },
          { id: "done", label: "Done" },
        ]}
      />
      <Row style={{ flexWrap: "wrap" }}>
        <StatusPill tone="running" label="Analyzing" busy />
        <StatusPill tone="error" icon="alert" label="Failed" />
        <StatusPill tone="warning" icon="alert" label="Interrupted" />
        <StatusPill tone="success" icon="check" label="Completed" />
        <StatusPill tone="needsInput" icon="upload" label="Ke zpracování" />
      </Row>
      <Row style={{ flexWrap: "wrap", gap: 6 }}>
        <Chip icon="person" label="Anna" />
        <Chip icon="clock" label="next week" />
        <Chip icon="waveform" label="0:00" onPress={() => {}} />
        <Chip
          icon="waveform"
          label="Plánování produktu Q4 s velmi dlouhým názvem schůzky"
          onPress={() => {}}
        />
      </Row>
      <Row>
        <IconTile icon="server" size={44} />
        <IconTile icon="sparkle" tone="violet" size={28} />
        <IconTile icon="alert" tone="amber" size={36} />
        <Text tone="secondary">Tiles name a place, not a state.</Text>
      </Row>
    </Stack>
  );
}
export default {
  title: "Foundation/Display",
  component: Display,
} satisfies Meta<typeof Display>;
export const All: StoryObj<typeof Display> = {};
