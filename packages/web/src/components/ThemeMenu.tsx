import { Moon, Sun, SunMoon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { THEME_PREFERENCES, useTheme } from "@/lib/theme";
import type { ThemePreference } from "@/lib/theme";

const LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/**
 * The colour scheme menu in the top bar: an icon for the scheme on screen (sun, moon, or both
 * while following the system), opening the choice of light, dark or system (`lib/theme.ts`).
 */
export function ThemeMenu() {
  const { preference, dark, theme } = useTheme();
  const Icon = preference === "system" ? SunMoon : dark ? Moon : Sun;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Colour scheme" className="shrink-0">
              <Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          Colour scheme: {LABELS[preference]}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel className="micro text-faint">Colour scheme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            const chosen = THEME_PREFERENCES.find((candidate) => candidate === value);
            if (chosen === undefined) {
              throw new Error(`The colour scheme menu has no item ${value}`);
            }
            theme.choose(chosen);
          }}
        >
          {THEME_PREFERENCES.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              {LABELS[choice]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
