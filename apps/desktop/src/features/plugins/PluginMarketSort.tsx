import { ArrowDownWideNarrow, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { pluginMarketSorts, type PluginMarketSort } from "../../../shared/plugin-market";

export function PluginMarketSortControl({
  value,
  query,
  ratings,
  onChange,
}: {
  value: PluginMarketSort;
  query: string;
  ratings: boolean;
  onChange: (value: PluginMarketSort) => void;
}) {
  const { t } = useTranslation();
  const label = value === "auto" ? (query.trim() ? "relevance" : "name-asc") : value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("pluginMarket.sort.title")}
          >
            <ArrowDownWideNarrow aria-hidden data-icon="inline-start" />
            {t("pluginMarket.sort.current", { value: t(`pluginMarket.sort.${label}`) })}
            <ChevronDown aria-hidden data-icon="inline-end" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (pluginMarketSorts.includes(next as PluginMarketSort))
              onChange(next as PluginMarketSort);
          }}
        >
          {pluginMarketSorts
            .filter((option) => ratings || (option !== "rating" && option !== "voters"))
            .map((option) => (
              <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                {t(`pluginMarket.sort.${option}`)}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
