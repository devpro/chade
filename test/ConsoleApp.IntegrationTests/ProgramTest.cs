using System;
using System.IO;
using Xunit;

namespace Chade.ConsoleApp.IntegrationTests;

public class ProgramTest
{
    [Fact]
    public void App_outputs_expected_text()
    {
        var sw = new StringWriter();
        Console.SetOut(sw);

        var entryPoint = typeof(Program).Assembly.EntryPoint!;
        entryPoint.Invoke(null, [(string[])["."]]);

        Assert.Contains("Started...", sw.ToString());
    }
}
