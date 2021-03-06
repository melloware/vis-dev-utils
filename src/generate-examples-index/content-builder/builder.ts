import fs from "fs";
import { join } from "path";
import { promisify } from "util";

import { Example, Examples, ExamplesRoot } from "../types";
import { Renderer, isExample } from "./common";
import { formatHTML } from "./format";
import { generateJSFiddlePage, generateCodePenPage } from "./playground";
import { generateScreenshot } from "./screenshots";

const collator = new Intl.Collator("US");
const writeFile = promisify(fs.writeFile);

export interface Checks {
  fail: number;
  failPaths: string[];
  okay: number;
  okayPaths: string[];
  percentage: number;
  total: number;
}

export interface ContentBuilderConfig {
  /** The tree structure with examples in it's leaves. */
  examples: ExamplesRoot;
  /** The directory where built files will be saved. */
  output: string;
  /** How many screenshots to generate at the same time. */
  parallel: number;
  /** The renderer used to generate index files. */
  renderer: Renderer;
  /** A script that will be executed on each page as first. */
  screenshotScript: string;
  /** A title that will be passed to the renderer. */
  title: string;
}

export class ContentBuilder {
  private _screenshotTodo: Example[] = [];
  private _playgroundTodo: Example[] = [];

  private readonly _fail: string[] = [];
  private readonly _okay: string[] = [];

  public constructor(private readonly _config: ContentBuilderConfig) {}

  /**
   * Build the files and write them to the disk.
   *
   * @param emit - Which types of files to emit.
   *
   * @returns A report with check results and the number of written files.
   */
  public build(
    emit: {
      index?: boolean;
      playgrounds?: boolean;
      screenshots?: boolean;
    } = {}
  ): {
    checks: Promise<Checks>;
    index: Promise<number>;
    playgrounds: Promise<number>;
    screenshots: Promise<number>;
  } {
    const allExamples = this._processGroup(this._config.examples);

    console.info(
      `Going to generate ${[
        emit.index ? ["index files"] : [],
        emit.playgrounds ? ["playground openers"] : [],
        emit.screenshots ? ["screenshots"] : []
      ]
        .flat()
        .join(", ")} for ${allExamples.length} examples.`
    );
    process.stdout.write("\n");

    this._playgroundTodo = allExamples.slice();
    this._screenshotTodo = allExamples.slice();

    const indexes = emit.index
      ? // Generate indexes.
        (async (): Promise<number> =>
          (await Promise.all(
            this._config.renderer
              .render(
                this._config.examples,
                this._config.output,
                this._config.title,
                collator
              )
              .map(
                async ({ content, filename }): Promise<void> =>
                  writeFile(join(this._config.output, filename), content)
              )
          )).length)()
      : // Skip indexes.
        Promise.resolve(0);

    const playgrounds = emit.playgrounds
      ? // Generate playground pages.
        (async (): Promise<number> =>
          (await Promise.all(
            this._playgroundTodo
              .splice(0)
              .flatMap((example): {
                html: string;
                path: string;
              }[] => {
                return [
                  {
                    html: generateJSFiddlePage(example),
                    path: example.paths.jsfiddle.local
                  },
                  {
                    html: generateCodePenPage(example),
                    path: example.paths.codepen.local
                  }
                ];
              })
              .map(
                async ({ html, path }): Promise<void> =>
                  writeFile(path, formatHTML(html))
              )
          )).length)()
      : // Skip playground pages.
        Promise.resolve(0);

    const screenshots = emit.screenshots
      ? // Generate screenshots.
        (async (): Promise<number> => {
          // Generate screenshots.
          // There is quite long delay to ensure the chart is rendered properly
          // so it's much faster to run a lot of them at the same time.
          const todo = this._screenshotTodo.splice(0);
          const total = todo.length;
          let finished = 0;
          await Promise.all(
            new Array(this._config.parallel).fill(null).map(
              async (): Promise<void> => {
                let example;
                while ((example = todo.pop())) {
                  const valid = await this._generateScreenshot(example);

                  if (valid) {
                    this._okay.push(example.path);
                  } else {
                    this._fail.push(example.path);
                  }

                  ++finished;

                  const percentage = (
                    Math.floor((finished / total) * 100) + "%"
                  ).padStart(4, " ");
                  const validText = valid ? "okay" : "fail";
                  console.info(`${percentage} ${validText} - ${example.path}`);
                }
              }
            )
          );

          return finished;
        })()
      : // Skip screenshots.
        Promise.resolve(0);

    const checks = (async (): Promise<Checks> => {
      await indexes;
      await playgrounds;
      await screenshots;

      const total = this._okay.length + this._fail.length;
      return {
        fail: this._fail.length,
        failPaths: this._fail,
        okay: this._okay.length,
        okayPaths: this._okay,
        percentage: total === 0 ? 100 : (100 * this._okay.length) / total,
        total
      };
    })();

    return { checks, index: indexes, playgrounds, screenshots };
  }

  private _processGroup(examples: Examples): Example[] {
    return Object.keys(examples)
      .sort(collator.compare)
      .flatMap((key): Example[] => {
        const example = examples[key];

        if (isExample(example)) {
          return [example];
        } else {
          return this._processGroup(example);
        }
      });
  }

  private async _generateScreenshot(example: Example): Promise<boolean> {
    return generateScreenshot({
      example,
      height: this._config.renderer.screenshot.height,
      screenshotScript: this._config.screenshotScript,
      width: this._config.renderer.screenshot.width
    });
  }
}
