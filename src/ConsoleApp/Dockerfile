FROM registry.suse.com/bci/dotnet-runtime:10.0 AS base
USER $APP_UID
WORKDIR /app

FROM registry.suse.com/bci/dotnet-sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
COPY ./Directory.*.props .
COPY ./src ./src
RUN dotnet restore "src/ConsoleApp/ConsoleApp.csproj"
RUN dotnet build "src/ConsoleApp/ConsoleApp.csproj" --no-restore -c "$BUILD_CONFIGURATION"

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
WORKDIR /src
RUN dotnet publish "src/ConsoleApp/ConsoleApp.csproj" --no-build -c "$BUILD_CONFIGURATION" -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
USER $APP_UID
ENV DOTNET_RUNNING_IN_CONTAINER=true \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1
ENTRYPOINT ["dotnet", "Chade.ConsoleApp.dll"]
