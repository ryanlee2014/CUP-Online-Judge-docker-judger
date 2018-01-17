const SANDBOX_DOCKER_IMAGE = "sandbox:v2";
const SANDBOX_UID = 1111;
const SANDBOX_GID = 1111;
const SANDBOX_PATH = '/sandbox';
const SANDBOX_EXEC_PATH = '/usr/bin/sandbox';
const SANDBOX_RESULT_PATH = '/sandbox/result.txt';

let Promise = require('bluebird');
let Docker = require('dockerode');
let TarStream = require('tar-stream');
let path = require('path');
let fs = Promise.promisifyAll(require('fs'));
let docker = Promise.promisifyAll(new Docker());

async function streamToBuffer(stream) {
    return await new Promise((resolve, reject) => {
        let buffers = [];
        stream.on('data', buffer => {
            buffers.push(buffer);
        });

        stream.on('end', () => {
            let buffer = Buffer.concat(buffers);
            resolve(buffer);
        });

        stream.on('error', reject);
    });
}

function flipSuffix(name, change = 0) {
    let _name = name;
    if (~name.indexOf(".")) {
        return _name.substring(0, _name.indexOf("."));
    }
    else {
        if (change) {
            return "data";
        }
        else {
            return name;
        }
    }

}

async function tar(files) {
    let pack = TarStream.pack();
    for (let file of files) {
        pack.entry(file, file.data);
    }
    pack.finalize();
    return await streamToBuffer(pack);
}

function parseResult(result) {
    let a = result.split('\n');
    return {
        status: a[0],
        debug_info: a[1],
        time_usage: parseInt(a[2]),
        memory_usage: parseInt(a[3])
    };
}

async function untar(data) {
    return await new Promise((resolve, reject) => {
        let extract = TarStream.extract(), res = [];
        extract.on('entry', async (header, stream, callback) => {
            header.data = await streamToBuffer(stream);
            res.push(header);
            callback();
        });

        extract.write(data);
        extract.end();

        extract.on('finish', () => {
            resolve(res);
        });
        extract.on('error', reject);
    });
}

module.exports = async options => {
    options = Object.assign({
        program: '',
        file_stdin: [],
        file_stdout: [],
        file_stderr: [],
        time_limit: 0,
        time_limit_reserve: 1,
        memory_limit: 0,
        memory_limit_reserve: 32 * 1024,
        large_stack: 0,
        output_limit: 0,
        process_limit: 0,
        input_files: [],
        output_files: [],
        compile_method: undefined
    }, options);

//  let container;

    try {
        // Check if the docker image exists
        let image = Promise.promisifyAll(docker.getImage(SANDBOX_DOCKER_IMAGE));

        try {
            await image.inspectAsync();
        } catch (e) {
            // Image not exists
            await new Promise((resolve, reject) => {
                // Pull the image
                docker.pull(SANDBOX_DOCKER_IMAGE, async (err, res) => {
                    if (err) reject(err);

                    // Check if the image is pulled
                    while (1) {
                        try {
                            await image.inspectAsync();
                            break;
                        } catch (e) {
                            // Delay 50ms
                            await Promise.delay(50);
                        }
                    }

                    resolve();
                });
            });
        }
        // Create the container
        let container = await docker.createContainerAsync({
            Image: SANDBOX_DOCKER_IMAGE,
            HostConfig: {
                NetworkMode: 'none'
            }
        });
        Promise.promisifyAll(container);

        async function getFile(path) {
            for (let i = 0; i < 10; i++) {
                try {
                    let stream = await container.getArchiveAsync({
                        path: path
                    });

                    // Convert stream to buffer
                    let buffer = await streamToBuffer(stream);

                    let tar = await untar(buffer);

                    return tar[0];
                } catch (e) {
                    continue;
                }
            }
            return null;
        }

        // Start the container
        await container.startAsync();

        // Put the files via tar
        for (let i in options.file_stdin) {
            options.input_files.push({
                name: path.basename(options.file_stdin[i]),
                mode: parseInt('755', 8),
                data: await fs.readFileAsync(options.file_stdin[i])
            })
        }
        if (~path.basename(options.program).indexOf(".")) {
            options.input_files.push({
                name: path.basename(options.program),
                mode: parseInt('755', 8),
                data: await fs.readFileAsync(options.program)
            });
        }


        for (let file of options.input_files) {
            file.uid = SANDBOX_UID;
            file.gid = SANDBOX_GID;
        }

        await container.putArchiveAsync(await tar(options.input_files), {
            path: SANDBOX_PATH
        });


        function getSandboxedPath(file) {
            if (file.length)
                return path.join(SANDBOX_PATH, path.basename(file));
            else
                return "";
        }

        if (options.file_stdin.length) {
            for (let i in options.file_stdin) {
                options.file_stdin[i] = getSandboxedPath(options.file_stdin[i]);
            }
        }
        else {
            options.file_stdin = [];
            options.file_stdin.push("");
        }
        if (options.file_stdout.length) {
            for (let i in options.file_stdout) {        // Exec the program with sandbox
                options.file_stdout[i] = getSandboxedPath(options.file_stdout[i]);
            }
        }
        else if (options.file_stdin.length) {
            for (let i in options.file_stdin) {
                options.file_stdout[i] = getSandboxedPath(flipSuffix(options.file_stdin[i]) + ".out");
            }
        }
        if (options.file_stderr.length) {
            for (let i in options.file_stderr) {
                options.file_stderr[i] = getSandboxedPath(options.file_stderr[i]);
            }
        }
        else if (options.file_stdin.length) {
            for (let i in options.file_stdin) {
                options.file_stderr[i] = getSandboxedPath(flipSuffix(options.file_stdin[i]) + ".err");
            }
        }
        // compile
        if (options.compile_method) {
            let compile_arg = options.compile_method(options.program, getSandboxedPath);
            let compile = await container.execAsync({
                Cmd: compile_arg
            });
            console.log(compile_arg);
            Promise.promisifyAll(compile);
            await compile.startAsync();
            let compileDaemon;
            do {
                compileDaemon = await compile.inspectAsync();
                await Promise.delay(50);
            } while (compileDaemon.Running);
        }

        let output_files = {};
        let output_errors = {};
        let _result = {};
        for (let i in options.file_stdin) {
            let cmd = [
                SANDBOX_EXEC_PATH,
                getSandboxedPath(flipSuffix(options.program)),
                options.file_stdin[i],
                options.file_stdout[i],
                options.file_stderr[i],
                options.time_limit.toString(),
                options.time_limit_reserve.toString(),
                options.memory_limit.toString(),
                options.memory_limit_reserve.toString(),
                parseInt(options.large_stack + 0).toString(),
                options.output_limit.toString(),
                options.process_limit.toString(),
                SANDBOX_RESULT_PATH
            ];
            console.log(cmd);
            let exec = await container.execAsync({
                Cmd: cmd,
                AttachStdout: true,
                AttachStderr: true
            });
            Promise.promisifyAll(exec);
            await exec.startAsync();
            let dataExec;
            do {
                dataExec = await exec.inspectAsync();
                await Promise.delay(50);
            } while (dataExec.Running);
            let result;
            while (!result) {
                let tmp = await getFile(SANDBOX_RESULT_PATH);
                if (tmp && tmp.data) result = tmp.data.toString();
                await Promise.delay(50);
            }
            _result[flipSuffix(options.file_stdin[i])] = (result = parseResult(result.toString()));
            let debug_info = result.debug_info.split().reverse().join("").split(" ")[0];
            debug_info = parseInt(debug_info);
            if (debug_info) {
                break;
            }
            let output_file, loop_time = 0;
            const total_time = options.time_limit + options.time_limit_reserve;
            console.log(total_time);
            output_file = await (async () => {
                console.log(`looping:${loop_time}`);
                let output_file;
                let tmp = await getFile(options.file_stdout[i]);
                if (tmp && tmp.data) output_file = tmp.data.toString();
                return output_file;
            })();
            if (loop_time > total_time * 4) {
                break;
            }
            let output_error;
            loop_time = 0;
            output_error = await (async () => {
                let output_error;
                console.log(`looping:${loop_time}`);
                let tmp = await getFile(options.file_stderr[i]);
                if (tmp && tmp.data) output_error = tmp.data.toString();
                return output_error
            })();
            output_files[path.basename(flipSuffix(options.file_stdin[i]))] = output_file;
            output_errors[path.basename(flipSuffix(options.file_stdin[i]))] = output_error;
        }
        container.removeAsync({
            force: true
        }).then(() => {
        }).catch(() => {
        });

        return {
            result: _result,
            output_files: output_files,
            output_errors: output_errors
        }
    } catch (e) {
        console.log(e);
        container.removeAsync({
            force: true
        }).then(() => {
        }).catch(() => {
        });
        throw e;
    }
};