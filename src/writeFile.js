import loaderUtils from 'loader-utils';
import path from 'path';
import cacache from 'cacache';
import serialize from 'serialize-javascript';
import { name, version } from '../package.json';
import findCacheDir from 'find-cache-dir';
import { stat, readFile } from './utils/promisify';

export default function writeFile(globalRef, pattern, file) {
    const {info, debug, compilation, fileDependencies, written, inputFileSystem, copyUnmodified} = globalRef;

    return stat(inputFileSystem, file.absoluteFrom)
    .then((stat) => {
        // We don't write empty directories
        if (stat.isDirectory()) {
            return;
        }

        // If this came from a glob, add it to the file watchlist
        if (pattern.fromType === 'glob') {
            fileDependencies.push(file.absoluteFrom);
        }

        info(`reading ${file.absoluteFrom} to write to assets`);
        return readFile(inputFileSystem, file.absoluteFrom)
        .then((content) => {
            if (pattern.transform) {
                const transform = (content, absoluteFrom) => {
                    return pattern.transform(content, absoluteFrom);
                };

                if (pattern.cache) {
                    if (!globalRef.cacheDir) {
                        globalRef.cacheDir = findCacheDir({ name: 'copy-webpack-plugin' });
                    }

                    const cacheKey = pattern.cache.key
                        ? pattern.cache.key
                        : serialize({
                            name,
                            version,
                            pattern,
                            content
                        });

                    return cacache
                    .get(globalRef.cacheDir, cacheKey)
                    .then(
                         (result) => result.data,
                          () => {
                              return Promise
                              .resolve()
                              .then(() => transform(content, file.absoluteFrom))
                              .then((content) => cacache.put(globalRef.cacheDir, cacheKey, content)
                              .then(() => content));
                          }
                     );
                }

                content = transform(content, file.absoluteFrom);
            }

            return content;
        }).catch((err) => {
            throw new Error(err);
        }).then((content) => {
            const hash = loaderUtils.getHashDigest(content);

            if (pattern.toType === 'template') {
                info(`interpolating template '${file.webpackTo}' for '${file.relativeFrom}'`);

                // A hack so .dotted files don't get parsed as extensions
                let basename = path.basename(file.relativeFrom);
                let dotRemoved = false;
                if (basename[0] === '.') {
                    dotRemoved = true;
                    file.relativeFrom = path.join(path.dirname(file.relativeFrom), basename.slice(1));
                }

                // If it doesn't have an extension, remove it from the pattern
                // ie. [name].[ext] or [name][ext] both become [name]
                if (!path.extname(file.relativeFrom)) {
                    file.webpackTo = file.webpackTo.replace(/\.?\[ext\]/g, '');
                }

                // A hack because loaderUtils.interpolateName doesn't
                // find the right path if no directory is defined
                // ie. [path] applied to 'file.txt' would return 'file'
                if (file.relativeFrom.indexOf(path.sep) < 0) {
                    file.relativeFrom = path.sep + file.relativeFrom;
                }

                file.webpackTo = loaderUtils.interpolateName(
                    { resourcePath: file.relativeFrom },
                    file.webpackTo,
                    { content });

                // Add back removed dots
                if (dotRemoved) {
                    let newBasename = path.basename(file.webpackTo);
                    file.webpackTo = path.dirname(file.webpackTo) + '/.' + newBasename;
                }
            }

            if (pattern.toType === 'function') {
                file.webpackTo = pattern.to(file.absoluteFrom, {
                    hash: globalRef.compilation.hash,
                    chunkHash: loaderUtils.interpolateName({}, '[hash]', { content }),
                    name: file.relativeFrom.split('.')[0].split('/')[0],
                    ext: file.relativeFrom.split('.')[1]
                });
                info(`function for ${file.absoluteFrom} resolved to '${file.webpackTo}'`);
            }

            if (!copyUnmodified &&
                written[file.absoluteFrom] &&
                written[file.absoluteFrom]['hash'] === hash &&
                written[file.absoluteFrom]['webpackTo'] === file.webpackTo
            ) {
                info(`skipping '${file.webpackTo}', because it hasn't changed`);
                return;
            } else {
                debug(`added ${hash} to written tracking for '${file.absoluteFrom}'`);
                written[file.absoluteFrom] = {
                    hash: hash,
                    webpackTo: file.webpackTo
                };
            }

            if (compilation.assets[file.webpackTo] && !file.force) {
                info(`skipping '${file.webpackTo}', because it already exists`);
                return;
            }

            info(`writing '${file.webpackTo}' to compilation assets from '${file.absoluteFrom}'`);
            compilation.assets[file.webpackTo] = {
                size: function() {
                    return stat.size;
                },
                source: function() {
                    return content;
                }
            };
        }).catch((err) => {
            throw new Error(err);
        });
    }).catch((err) => {
        throw new Error(err);
    });
}
