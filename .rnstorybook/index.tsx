import { registerRootComponent } from "expo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { view } from "./storybook.requires";
const Storybook = view.getStorybookUI({
  storage: { getItem: AsyncStorage.getItem, setItem: AsyncStorage.setItem },
});
registerRootComponent(Storybook);
export default Storybook;
