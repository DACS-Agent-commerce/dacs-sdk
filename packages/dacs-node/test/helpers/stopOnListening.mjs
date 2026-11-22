// Preload for child processes in tests: sends the process SIGTERM from inside the write of its
// "listening" line, the earliest moment a reader of that line could stop it.
const write = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk, ...rest) => {
  const written = write(chunk, ...rest);
  if (String(chunk).includes("\"status\":\"listening\"")) process.kill(process.pid, "SIGTERM");
  return written;
};
