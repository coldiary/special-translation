import {
  parse,
  printAST,
  TYPE,
  type MessageFormatElement,
} from '@generaltranslation/icu';
import type {
  Content,
  DataFormat,
  JsxChildren,
} from '@generaltranslation/format/types';
import { llmError } from './config';

type MapText = (text: string) => string;

/** Only text is exposed for replacement; component/variable structure stays local. */
export function mapContent(
  source: Content,
  format: DataFormat,
  map: MapText
): Content {
  if (format === 'JSX') return mapJsx(source, map);
  if (typeof source !== 'string')
    throw llmError('String translation formats require string content');
  if (format === 'ICU') {
    const ast = parse(source);
    mapIcu(ast, map);
    return printAST(ast);
  }
  if (format === 'I18NEXT') {
    // Keep interpolation and nesting expressions immutable, including format options.
    return source
      .split(/(\{\{[\s\S]*?\}\}|\$t\([^)]*\))/g)
      .map((part, index) => (index % 2 ? part : map(part)))
      .join('');
  }
  return map(source);
}

function mapJsx(source: JsxChildren, map: MapText): JsxChildren {
  if (typeof source === 'string') return map(source);
  if (Array.isArray(source))
    return source.map((child) => mapJsx(child, map)) as JsxChildren;
  if (source === null || typeof source === 'boolean' || 'k' in source)
    return source;
  const result = { ...source };
  if (source.c !== undefined) result.c = mapJsx(source.c, map);
  if (source.d) {
    result.d = { ...source.d };
    for (const key of ['pl', 'ti', 'alt', 'arl'] as const) {
      if (source.d[key] !== undefined) result.d[key] = map(source.d[key]);
    }
    // aria-labelledby/describedby contain element IDs, not translatable text.
    if (source.d.b)
      result.d.b = Object.fromEntries(
        Object.entries(source.d.b).map(([key, child]) => [
          key,
          mapJsx(child, map),
        ])
      );
  }
  return result;
}

function mapIcu(ast: MessageFormatElement[], map: MapText): void {
  for (const element of ast) {
    if (element.type === TYPE.literal) element.value = map(element.value);
    else if (element.type === TYPE.tag) mapIcu(element.children, map);
    else if (element.type === TYPE.select || element.type === TYPE.plural) {
      for (const option of Object.values(element.options))
        mapIcu(option.value, map);
    }
  }
}
