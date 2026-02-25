#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>

static EventHotKeyRef gHotKeyRef = NULL;
static EventHotKeyRef gNumpadHotKeyRef = NULL;
static EventHotKeyRef gFallbackHotKeyRef = NULL;
static NSString *gScriptPath = nil;
static NSString *gDaemonLogPath = nil;
static NSTimeInterval gCooldownSeconds = 2.0;
static NSDate *gLastTriggerAt = nil;
static NSString *gLastSummaryText = @"No summary yet.";
static BOOL gSummaryTaskRunning = NO;

static NSStatusItem *gStatusItem = nil;
static NSMenuItem *gStatusMenuItem = nil;
static NSMenuItem *gLastSummaryMenuItem = nil;
static __strong id gMenuController = nil;

static NSString *NowStamp(void);
static void AppendLog(NSString *line);
static NSString *NormalizeSingleLine(NSString *text, NSUInteger maxLength);
static void UpdateStatusVisual(NSString *badge, NSString *statusText, NSString *detailText);
static void RunSummaryScriptWithReason(NSString *reason);

@interface HotkeyMenuController : NSObject
- (void)runSummaryNow:(id)sender;
- (void)copyLastSummary:(id)sender;
- (void)openLogsFolder:(id)sender;
@end

@implementation HotkeyMenuController
- (void)runSummaryNow:(id)sender {
    (void)sender;
    RunSummaryScriptWithReason(@"menu");
}

- (void)copyLastSummary:(id)sender {
    (void)sender;
    NSString *summary = gLastSummaryText ?: @"No summary yet.";
    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    [pasteboard clearContents];
    [pasteboard setString:summary forType:NSPasteboardTypeString];
    AppendLog(@"Copied last summary to clipboard from menu.");
    UpdateStatusVisual(@"MRN+", @"Copied", summary);
}

- (void)openLogsFolder:(id)sender {
    (void)sender;
    if (!gDaemonLogPath || gDaemonLogPath.length == 0) return;
    NSString *logsFolder = [gDaemonLogPath stringByDeletingLastPathComponent];
    NSURL *logsURL = [NSURL fileURLWithPath:logsFolder];
    [[NSWorkspace sharedWorkspace] openURL:logsURL];
}
@end

static NSString *NowStamp(void) {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss";
    return [formatter stringFromDate:[NSDate date]];
}

static void AppendLog(NSString *line) {
    if (!gDaemonLogPath || gDaemonLogPath.length == 0) return;
    NSString *record = [NSString stringWithFormat:@"[%@] %@\n", NowStamp(), line ?: @""];
    NSData *recordData = [record dataUsingEncoding:NSUTF8StringEncoding];
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:gDaemonLogPath]) {
        [fileManager createFileAtPath:gDaemonLogPath contents:recordData attributes:nil];
        return;
    }

    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:gDaemonLogPath];
    if (!handle) return;
    @try {
        [handle seekToEndOfFile];
        [handle writeData:recordData];
    } @catch (NSException *exception) {
        (void)exception;
    } @finally {
        [handle closeFile];
    }
}

static NSString *NormalizeSingleLine(NSString *text, NSUInteger maxLength) {
    NSString *single = text ?: @"";
    single = [single stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
    single = [single stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (single.length == 0) return @"N/A";
    if (single.length <= maxLength || maxLength < 4) return single;
    return [[single substringToIndex:maxLength - 3] stringByAppendingString:@"..."];
}

static void UpdateStatusVisual(NSString *badge, NSString *statusText, NSString *detailText) {
    NSString *safeBadge = badge ?: @"MRN";
    NSString *safeStatus = statusText ?: @"Idle";
    NSString *safeDetail = NormalizeSingleLine(detailText ?: gLastSummaryText, 140);
    dispatch_async(dispatch_get_main_queue(), ^{
        if (gStatusItem.button) {
            gStatusItem.button.title = safeBadge;
            gStatusItem.button.toolTip = [NSString stringWithFormat:
                @"MailroomNavigator\nStatus: %@\nLast: %@\nShortcuts: Cmd+Shift+9 or Cmd+Ctrl+9",
                safeStatus,
                safeDetail
            ];
        }
        if (gStatusMenuItem) {
            gStatusMenuItem.title = [NSString stringWithFormat:@"Status: %@", safeStatus];
        }
        if (gLastSummaryMenuItem) {
            gLastSummaryMenuItem.title = [NSString stringWithFormat:@"Last summary: %@", safeDetail];
        }
    });
}

static void SetupMenuBarIndicator(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    gMenuController = [[HotkeyMenuController alloc] init];
    gStatusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    if (!gStatusItem) {
        AppendLog(@"Failed to create menu bar status item.");
        return;
    }

    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"MailroomNavigator"];

    gStatusMenuItem = [[NSMenuItem alloc] initWithTitle:@"Status: Starting" action:nil keyEquivalent:@""];
    gStatusMenuItem.enabled = NO;
    [menu addItem:gStatusMenuItem];

    gLastSummaryMenuItem = [[NSMenuItem alloc] initWithTitle:@"Last summary: No summary yet." action:nil keyEquivalent:@""];
    gLastSummaryMenuItem.enabled = NO;
    [menu addItem:gLastSummaryMenuItem];

    [menu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *runNowItem = [[NSMenuItem alloc] initWithTitle:@"Run Summary Now" action:@selector(runSummaryNow:) keyEquivalent:@""];
    runNowItem.target = gMenuController;
    [menu addItem:runNowItem];

    NSMenuItem *copyLastItem = [[NSMenuItem alloc] initWithTitle:@"Copy Last Summary" action:@selector(copyLastSummary:) keyEquivalent:@""];
    copyLastItem.target = gMenuController;
    [menu addItem:copyLastItem];

    NSMenuItem *openLogsItem = [[NSMenuItem alloc] initWithTitle:@"Open Logs Folder" action:@selector(openLogsFolder:) keyEquivalent:@""];
    openLogsItem.target = gMenuController;
    [menu addItem:openLogsItem];

    gStatusItem.menu = menu;
    UpdateStatusVisual(@"MRN", @"Idle", @"Ready");
    AppendLog(@"Menu bar heartbeat indicator started.");
}

static void RunSummaryScriptWithReason(NSString *reason) {
    if (gSummaryTaskRunning) {
        AppendLog(@"Hotkey ignored because summary run is already in progress.");
        UpdateStatusVisual(@"MRN...", @"Running", @"A summary run is already in progress.");
        return;
    }

    NSDate *now = [NSDate date];
    NSString *reasonLabel = (reason.length > 0) ? reason : @"hotkey";
    if (gLastTriggerAt && [now timeIntervalSinceDate:gLastTriggerAt] < gCooldownSeconds) {
        AppendLog(@"Hotkey ignored due to cooldown.");
        UpdateStatusVisual(@"MRN", @"Cooldown", @"Please wait before running again.");
        return;
    }
    gLastTriggerAt = now;
    gSummaryTaskRunning = YES;
    AppendLog([NSString stringWithFormat:@"Hotkey pressed. Starting summary script (reason=%@).", reasonLabel]);
    UpdateStatusVisual(@"MRN...", @"Running", @"Fetching latest dashboard summary...");

    if (!gScriptPath || gScriptPath.length == 0) {
        AppendLog(@"Script path is empty.");
        UpdateStatusVisual(@"MRN!", @"Config error", @"Script path is empty.");
        gSummaryTaskRunning = NO;
        return;
    }

    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/bin/bash";
    task.arguments = @[gScriptPath];
    task.environment = [[NSProcessInfo processInfo] environment];

    NSPipe *stdoutPipe = [NSPipe pipe];
    NSPipe *stderrPipe = [NSPipe pipe];
    task.standardOutput = stdoutPipe;
    task.standardError = stderrPipe;

    @try {
        [task launch];
    } @catch (NSException *exception) {
        NSString *reasonText = exception.reason ?: @"unknown";
        AppendLog([NSString stringWithFormat:@"Failed to launch summary script: %@", reasonText]);
        UpdateStatusVisual(@"MRN!", @"Launch failed", reasonText);
        gSummaryTaskRunning = NO;
        return;
    }

    [task setTerminationHandler:^(NSTask *finishedTask) {
        NSData *outData = [[stdoutPipe fileHandleForReading] readDataToEndOfFile];
        NSData *errData = [[stderrPipe fileHandleForReading] readDataToEndOfFile];
        NSString *outText = [[NSString alloc] initWithData:outData encoding:NSUTF8StringEncoding] ?: @"";
        NSString *errText = [[NSString alloc] initWithData:errData encoding:NSUTF8StringEncoding] ?: @"";
        outText = NormalizeSingleLine(outText, 240);
        errText = NormalizeSingleLine(errText, 240);

        if (finishedTask.terminationStatus == 0) {
            gLastSummaryText = outText;
            AppendLog([NSString stringWithFormat:@"Summary script completed: %@", outText]);
            UpdateStatusVisual(@"MRN+", @"Last run succeeded", outText);
        } else {
            NSString *failureText = (errText.length > 0) ? errText : @"Summary script failed.";
            gLastSummaryText = [NSString stringWithFormat:@"Failed: %@", failureText];
            AppendLog([NSString stringWithFormat:@"Summary script failed (status=%d): %@", finishedTask.terminationStatus, failureText]);
            UpdateStatusVisual(@"MRN!", @"Last run failed", failureText);
        }
        gSummaryTaskRunning = NO;
    }];
}

static void RunSummaryScript(void) {
    RunSummaryScriptWithReason(@"hotkey");
}

static void RunHotkeyEventLoop(void) {
    AppendLog(@"Hotkey event loop started.");
    while (1) {
        EventRef event = NULL;
        OSStatus receiveStatus = ReceiveNextEvent(0, NULL, kEventDurationSecond, true, &event);
        if (receiveStatus == eventLoopTimedOutErr) {
            continue;
        }

        if (receiveStatus != noErr) {
            AppendLog([NSString stringWithFormat:@"ReceiveNextEvent failed: %d", (int)receiveStatus]);
            [NSThread sleepForTimeInterval:0.25];
            continue;
        }

        if (event) {
            SendEventToEventTarget(event, GetApplicationEventTarget());
            ReleaseEvent(event);
        }
    }
}

static OSStatus HotKeyHandler(EventHandlerCallRef nextHandler, EventRef event, void *userData) {
    (void)nextHandler;
    (void)userData;

    EventHotKeyID hotKeyId;
    OSStatus status = GetEventParameter(
        event,
        kEventParamDirectObject,
        typeEventHotKeyID,
        NULL,
        sizeof(EventHotKeyID),
        NULL,
        &hotKeyId
    );
    if (status != noErr) return noErr;

    if (hotKeyId.signature == 'MRHS' && (hotKeyId.id == 1 || hotKeyId.id == 2)) {
        AppendLog([NSString stringWithFormat:@"Hotkey event received (id=%u).", (unsigned int)hotKeyId.id]);
        RunSummaryScript();
    }
    return noErr;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDictionary *env = [[NSProcessInfo processInfo] environment];
        gScriptPath = env[@"MAILROOM_HOTKEY_SCRIPT_PATH"];
        gDaemonLogPath = env[@"MAILROOM_HOTKEY_DAEMON_LOG"];
        NSString *cooldownText = env[@"MAILROOM_HOTKEY_COOLDOWN_SECONDS"];
        if (cooldownText.length > 0) {
            gCooldownSeconds = MAX(0.5, [cooldownText doubleValue]);
        }

        if (!gScriptPath || gScriptPath.length == 0) {
            fprintf(stderr, "MAILROOM_HOTKEY_SCRIPT_PATH is required.\n");
            return 1;
        }
        if (!gDaemonLogPath || gDaemonLogPath.length == 0) {
            fprintf(stderr, "MAILROOM_HOTKEY_DAEMON_LOG is required.\n");
            return 1;
        }

        AppendLog(@"Hotkey daemon starting (Cmd+Shift+9).");

        ProcessSerialNumber psn = {0, kCurrentProcess};
        OSStatus transformStatus = TransformProcessType(&psn, kProcessTransformToUIElementApplication);
        if (transformStatus != noErr) {
            AppendLog([NSString stringWithFormat:@"TransformProcessType failed: %d", (int)transformStatus]);
        }

        SetupMenuBarIndicator();

        if (argc > 1 && strcmp(argv[1], "--self-test") == 0) {
            RunSummaryScriptWithReason(@"self-test");
            [NSThread sleepForTimeInterval:1.5];
            AppendLog(@"Self-test finished.");
            return 0;
        }

        EventTypeSpec eventType;
        eventType.eventClass = kEventClassKeyboard;
        eventType.eventKind = kEventHotKeyPressed;

        OSStatus installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            NewEventHandlerUPP(HotKeyHandler),
            1,
            &eventType,
            NULL,
            NULL
        );
        if (installStatus != noErr) {
            AppendLog([NSString stringWithFormat:@"Failed to install hotkey event handler: %d", (int)installStatus]);
            UpdateStatusVisual(@"MRN!", @"Hotkey error", @"Cannot install event handler.");
            return 1;
        }

        EventHotKeyID hotKeyId;
        hotKeyId.signature = 'MRHS';
        hotKeyId.id = 1;

        OSStatus registerStatus = RegisterEventHotKey(
            kVK_ANSI_9,
            cmdKey | shiftKey,
            hotKeyId,
            GetApplicationEventTarget(),
            0,
            &gHotKeyRef
        );
        if (registerStatus != noErr) {
            AppendLog([NSString stringWithFormat:@"Failed to register global hotkey: %d", (int)registerStatus]);
            UpdateStatusVisual(@"MRN!", @"Hotkey error", @"Primary shortcut registration failed.");
            return 1;
        }

        OSStatus numpadStatus = RegisterEventHotKey(
            kVK_ANSI_Keypad9,
            cmdKey | shiftKey,
            hotKeyId,
            GetApplicationEventTarget(),
            0,
            &gNumpadHotKeyRef
        );
        if (numpadStatus != noErr) {
            AppendLog([NSString stringWithFormat:@"Numpad hotkey registration skipped: %d", (int)numpadStatus]);
        }

        EventHotKeyID fallbackHotKeyId;
        fallbackHotKeyId.signature = 'MRHS';
        fallbackHotKeyId.id = 2;
        OSStatus fallbackStatus = RegisterEventHotKey(
            kVK_ANSI_9,
            cmdKey | controlKey,
            fallbackHotKeyId,
            GetApplicationEventTarget(),
            0,
            &gFallbackHotKeyRef
        );
        if (fallbackStatus == noErr) {
            AppendLog(@"Fallback hotkey registered (Cmd+Ctrl+9).");
        } else {
            AppendLog([NSString stringWithFormat:@"Fallback hotkey registration skipped: %d", (int)fallbackStatus]);
        }

        AppendLog(@"Global hotkey registered successfully (Cmd+Shift+9 primary).");
        UpdateStatusVisual(@"MRN", @"Idle", @"Waiting for shortcut.");
        RunHotkeyEventLoop();
    }
    return 0;
}
