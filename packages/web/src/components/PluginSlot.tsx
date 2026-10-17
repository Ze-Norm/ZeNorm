import type { Stage } from "@zenorm/contracts";
import type { SlotName, SlotProps, WebPlugin } from "@zenorm/plugin-sdk";
import { createContext, useContext } from "react";
import type { ComponentType } from "react";

/** The composition's web plugins, in plugin order; provided once by `createWebApp`. */
export const WebPluginsContext = createContext<readonly WebPlugin[] | null>(null);

function useWebPlugins(): readonly WebPlugin[] {
  const plugins = useContext(WebPluginsContext);
  if (plugins === null) {
    throw new Error("PluginSlot needs the WebPluginsContext provider (createWebApp)");
  }
  return plugins;
}

/**
 * A slot host: every plugin's component for `name`, in plugin order, with the slot's
 * props. It renders no element of its own, so a slot no plugin fills changes nothing on the page.
 */
export function PluginSlot<S extends SlotName>({ name, props }: { name: S; props: SlotProps[S] }) {
  const plugins = useWebPlugins();
  return (
    <>
      {plugins.map((plugin) => {
        const Component: ComponentType<SlotProps[S]> | undefined = plugin.slots[name];
        return Component === undefined ? null : <Component key={plugin.id} {...props} />;
      })}
    </>
  );
}

/** Whether any plugin renders into `name`, for a host that frames the slot only when it is filled. */
export function useSlotFilled(name: SlotName): boolean {
  return useWebPlugins().some((plugin) => plugin.slots[name] !== undefined);
}

/**
 * The `map.workspace.aside` host: first in a map page's right column, the Activity column or Run
 * activity, on every stage and on Wayfinding's and Delivery's own pages. It frames its
 * plugins only when one fills the slot, so with none the column is as before.
 */
export function MapAside({
  projectId,
  mapId,
  stage,
}: {
  projectId: string;
  mapId: string;
  stage: Stage;
}) {
  const filled = useSlotFilled("map.workspace.aside");
  if (!filled) {
    return null;
  }
  return (
    <div className="grid shrink-0 gap-2.5 border-b border-border p-3.5">
      <PluginSlot name="map.workspace.aside" props={{ projectId, mapId, stage }} />
    </div>
  );
}
