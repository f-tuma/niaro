import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  AttachmentTray,
  AttachmentProcessing,
  PersistedAttachments,
} from "../packages/ui-catalog/AttachmentTray";
import { AttachmentPicker } from "../packages/ui-catalog/AttachmentPicker";
import { AttachmentPreview } from "../packages/ui-catalog/AttachmentPreview";
import { Composer } from "../apps/mobile/ScreenChrome";
import type { DraftAttachment } from "../packages/ui-catalog/attachment-presentation";

const file: DraftAttachment = {
  id: "f1",
  filename: "Podklady_rozpočet.pdf",
  detail: "PDF · 1 MB",
  kind: "file",
  transfer: { state: "failed" },
};

test("per-file retry/remove are explicit callbacks, leaving successful siblings and supplied state intact", () => {
  const retry = jest.fn();
  const remove = jest.fn();
  const files: DraftAttachment[] = [
    { ...file, retry: { onPress: retry }, remove: { onPress: remove } },
    {
      ...file,
      id: "f2",
      filename: "Ready.pdf",
      transfer: { state: "uploaded" },
    },
  ];
  render(<AttachmentTray files={files} language="cs" />);
  expect(retry).not.toHaveBeenCalled();
  fireEvent.press(
    screen.getByRole("button", { name: `Opakovat nahrání: ${file.filename}` }),
  );
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Nahrání selhalo")).toBeTruthy();
  expect(screen.getByText("Nahráno")).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: `Odebrat: ${file.filename}` }),
  );
  expect(remove).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("attachment-f2")).toBeTruthy();
});

test("uncertain upload never exposes a mutation retry even if a stale callback arrives", () => {
  const retry = jest.fn();
  render(
    <AttachmentTray
      language="en"
      files={[
        {
          ...file,
          transfer: { state: "uncertain" },
          retry: { onPress: retry },
        },
      ]}
    />,
  );
  expect(screen.getByText("Upload unconfirmed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  expect(retry).not.toHaveBeenCalled();
});

test("unavailable history suppresses preview/download; failed interpretation preserves original access", () => {
  const download = jest.fn();
  const preview = jest.fn();
  const process = jest.fn();
  const props = {
    language: "en" as const,
    files: [
      {
        ...file,
        availability: "available" as const,
        preview: { onPress: preview },
        download: { onPress: download },
      },
    ],
  };
  const { rerender } = render(
    <>
      <PersistedAttachments {...props} />
      <AttachmentProcessing
        language="en"
        value={{ state: "failed", retry: { onPress: process } }}
      />
    </>,
  );
  fireEvent.press(
    screen.getByRole("button", { name: `Download: ${file.filename}` }),
  );
  expect(download).toHaveBeenCalledTimes(1);
  expect(process).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Retry processing" }));
  expect(process).toHaveBeenCalledTimes(1);
  rerender(
    <PersistedAttachments
      language="en"
      files={[{ ...props.files[0]!, availability: "unavailable" }]}
    />,
  );
  expect(screen.getByText("File unavailable")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(preview).not.toHaveBeenCalled();
});

test("camera choices are supplied capabilities and disabled actions never execute", () => {
  const camera = jest.fn();
  const task = jest.fn();
  render(
    <AttachmentPicker
      language="cs"
      choices={{
        camera: { onPress: camera, disabled: true },
        task: { onPress: task },
      }}
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Fotoaparát" }));
  expect(camera).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Fotky" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Úkol" }));
  expect(task).toHaveBeenCalledTimes(1);
});

test("preview rejects network and active-content sources; rotation and confirmation remain controlled", () => {
  const rotate = jest.fn();
  const confirm = jest.fn();
  const retake = jest.fn();
  const props = {
    language: "en" as const,
    filename: "Card.jpg",
    rotation: 0 as const,
    rotate: { onPress: rotate },
    confirm: { onPress: confirm },
    retake: { onPress: retake },
  };
  const { rerender } = render(
    <AttachmentPreview
      {...props}
      raster={{
        mediaType: "image/jpeg",
        uri: "https://storage.invalid/private.jpg",
      }}
    />,
  );
  expect(screen.queryByLabelText("Card.jpg")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Use photo" }));
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Retake" }));
  expect(retake).toHaveBeenCalledTimes(1);
  rerender(
    <AttachmentPreview
      {...props}
      raster={{
        mediaType: "image/jpeg",
        uri: "data:image/svg+xml;base64,PHN2Zz4=",
      }}
    />,
  );
  expect(screen.queryByLabelText("Card.jpg")).toBeNull();
  rerender(
    <AttachmentPreview
      {...props}
      raster={{ mediaType: "image/jpeg", uri: "file:///transient/card.jpg" }}
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Rotate" }));
  expect(rotate).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Use photo" }));
  expect(confirm).toHaveBeenCalledTimes(1);
});

test("file-only composer uses parent readiness and retains the text-only voice default", () => {
  const send = jest.fn();
  const voice = jest.fn();
  const props = {
    language: "en" as const,
    value: "",
    onChange: jest.fn(),
    onSend: send,
    onVoice: voice,
    disabled: true,
  };
  const { rerender } = render(<Composer {...props} />);
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  rerender(<Composer {...props} hasAttachments />);
  fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(send).not.toHaveBeenCalled();
  rerender(<Composer {...props} hasAttachments disabled={false} />);
  fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(voice).not.toHaveBeenCalled();
});
