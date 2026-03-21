using System.Text;

Console.WriteLine("Started...");

// example: set a variable to the My Documents path.
// string docPath = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);

var sb = new StringBuilder();

var diTop = new DirectoryInfo(args[0]);

try
{
    sb.AppendLine(diTop.FullName);
    foreach (var fi in diTop.EnumerateFiles())
    {
        try
        {
            if (fi.Length > 10000000) // 10 MB
            {
                sb.AppendLine($"- {fi.Name}: {GetFileLength(fi)}");
            }
        }
        catch (UnauthorizedAccessException unAuthTop)
        {
            Console.WriteLine($"{unAuthTop.Message}");
        }
    }

    foreach (var di in diTop.EnumerateDirectories("*"))
    {
        try
        {
            sb.AppendLine(di.FullName);
            foreach (var fi in di.EnumerateFiles("*", SearchOption.AllDirectories))
            {
                try
                {
                    // Display each file over 10 MB;
                    if (fi.Length > 10000000)
                    {
                        sb.AppendLine($"- {fi.Name}: {GetFileLength(fi)}");
                    }
                }
                catch (UnauthorizedAccessException unAuthFile)
                {
                    Console.WriteLine($"unAuthFile: {unAuthFile.Message}");
                }
            }
        }
        catch (UnauthorizedAccessException unAuthSubDir)
        {
            Console.WriteLine($"unAuthSubDir: {unAuthSubDir.Message}");
        }
    }
}
catch (DirectoryNotFoundException dirNotFound)
{
    Console.WriteLine($"{dirNotFound.Message}");
}
catch (UnauthorizedAccessException unAuthDir)
{
    Console.WriteLine($"unAuthDir: {unAuthDir.Message}");
}
catch (PathTooLongException longPath)
{
    Console.WriteLine($"{longPath.Message}");
}

var outputFilename = $"output.{DateTime.Now:yyyyMMddHHmmss}.txt";
File.WriteAllText(outputFilename, sb.ToString(), Encoding.UTF8);
var outputFileInfo = new FileInfo(outputFilename);
Console.WriteLine($"File \"{outputFileInfo.FullName}\" has been generated ({GetFileLength(outputFileInfo)})");
return;

static string GetFileLength(FileInfo fileInfo)
{
    string[] sizes = ["B", "KB", "MB", "GB", "TB"];
    double len = fileInfo.Length;
    var order = 0;
    while (len >= 1024 && order < sizes.Length - 1)
    {
        order++;
        len /= 1024;
    }

    return $"{len:0.##} {sizes[order]}";
}
