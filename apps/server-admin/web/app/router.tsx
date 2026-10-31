import { PetPage, PetMemoryPage } from "./pet-page";
import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppShell } from "./shell";
import { ChatNextPage } from "./chat-next/chat-next-page";
import { HubPage } from "./hub-page";
import { TasksPage } from "./tasks-page";
import { MeetingsPage } from "./meetings-page";
import { MeetingDetailPage } from "./meeting-detail-page";
import { ProcessesPage } from "./processes-page";
import { ConnectionsPage } from "./connections-page";
import { ConnectionDetailPage } from "./connection-detail";
import { SearchPage } from "./search-page";
import { AccountPage } from "./account-page";
import { PersonalDesignPage, PersonalProcessPage } from "./process-pages";
import { SkillPage, SkillsPage } from "./skills-page";
import { designSearchSchema } from "../process-design-page";

const root = createRootRoute({ component: AppShell });
// "/" is the person's dashboard (Overview), where the app opens.
const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: HubPage,
});
// One chat page for "/chat" (a new chat) and "/chat/$id", so a new chat keeps
// its state when its first message gives it an address.
function ChatRoute() {
  return <ChatNextPage />;
}
const chatLayout = createRoute({
  getParentRoute: () => root,
  id: "chat",
  component: ChatRoute,
});
const chat = createRoute({
  getParentRoute: () => chatLayout,
  path: "/chat",
  component: () => null,
});
const conversation = createRoute({
  getParentRoute: () => chatLayout,
  path: "/chat/$conversationId",
  component: () => null,
});
const tasks = createRoute({
  getParentRoute: () => root,
  path: "/tasks",
  component: TasksPage,
});
const meetings = createRoute({
  getParentRoute: () => root,
  path: "/meetings",
  component: MeetingsPage,
});
const meeting = createRoute({
  getParentRoute: () => root,
  path: "/meetings/$meetingId",
  component: MeetingDetailPage,
});
const processes = createRoute({
  getParentRoute: () => root,
  path: "/processes",
  component: ProcessesPage,
});
// The same paths as the console's, so the shared designer and process page
// link between each other unchanged.
const processDesign = createRoute({
  getParentRoute: () => root,
  path: "/processes/design",
  validateSearch: (search) => designSearchSchema.parse(search),
  component: PersonalDesignPage,
});
const processDetail = createRoute({
  getParentRoute: () => root,
  path: "/processes/$processId",
  component: PersonalProcessPage,
});
const skills = createRoute({
  getParentRoute: () => root,
  path: "/skills",
  component: SkillsPage,
});
// `/skills/new` and `/skills/new-company` (administrators) create one.
const skill = createRoute({
  getParentRoute: () => root,
  path: "/skills/$skillId",
  component: SkillPage,
});
const connections = createRoute({
  getParentRoute: () => root,
  path: "/connections",
  component: ConnectionsPage,
});
// One personal service: the account and what the assistant may do with it.
const connection = createRoute({
  getParentRoute: () => root,
  path: "/connections/$serviceId",
  component: ConnectionDetailPage,
});
// Search in the person's chats (Ctrl/Cmd+K).
const search = createRoute({
  getParentRoute: () => root,
  path: "/search",
  component: SearchPage,
});

// "/me" because "/account/*" are the public sign-in pages.
const account = createRoute({
  getParentRoute: () => root,
  path: "/me",
  component: AccountPage,
});

const pet = createRoute({
  getParentRoute: () => root,
  path: "/pet",
  component: PetPage,
});
const petMemory = createRoute({
  getParentRoute: () => root,
  path: "/me/memory",
  component: PetMemoryPage,
});

/** The web app's pages; the console keeps its own router under /admin. */
export const appRouter = createRouter({
  routeTree: root.addChildren([
    home,
    chatLayout.addChildren([chat, conversation]),
    tasks,
    meetings,
    meeting,
    processes,
    processDesign,
    processDetail,
    skills,
    skill,
    connections,
    connection,
    search,
    account,
    pet,
    petMemory,
  ]),
  basepath: "/",
});
