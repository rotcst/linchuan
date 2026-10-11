import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export type SelectOption<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
};

export function SelectMenu<Value extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  id,
  className = '',
  hideLabel = false,
}: {
  value: Value;
  options: readonly SelectOption<Value>[];
  onValueChange: (value: Value) => void;
  ariaLabel: string;
  id?: string;
  className?: string;
  hideLabel?: boolean;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        type="button"
        id={id}
        className={`select-trigger ${className}`}
        aria-label={ariaLabel}
        title={`${ariaLabel}: ${selected?.label || ''}`}
        data-value={value}
      >
        {selected?.icon}
        {!hideLabel && <span className="select-label">{selected?.label}</span>}
        <ChevronDown className="select-chevron" size={13} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`select-menu ${className ? `${className}-menu` : ''}`}
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={ariaLabel}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => {
              const option = options.find((item) => item.value === next);
              if (option) onValueChange(option.value);
            }}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                className="select-option"
                value={option.value}
                key={option.value}
              >
                {option.icon}
                <span className="select-option-label">{option.label}</span>
                <span className="select-indicator">
                  <DropdownMenu.ItemIndicator>
                    <Check size={15} aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
