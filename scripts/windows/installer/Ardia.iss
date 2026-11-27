#define Shell "webui"
#define LaunchSwitch "--ardia-shell=webui"
#define OpenSuffix " --ardia-shell=webui"
#define ShellMarker "ardia-ui\index.html"
#define RetiredShell "rnw"
#define RetiredMarker "ArdiaApp.dll"
#define LoginItemName "Ardia WebUI"
#define RetiredLoginItemName "Ardia"

[Setup]
AppId={{47A92F18-32B0-4548-A1EF-72C217FE1836}
AppName=Ardia
AppVersion={#Version}
AppVerName=Ardia {#Version}
AppPublisher=Ardia
AppPublisherURL=https://ardia.dev
AppSupportURL=https://github.com/ardia-browser/ardia/issues
DefaultDirName={localappdata}\Programs\Ardia
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir={#Out}
OutputBaseFilename=Ardia-Setup-{#Cpu}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
ArchitecturesAllowed={#Allowed}
ArchitecturesInstallIn64BitMode={#Allowed}
SetupIconFile={#Icon}
UninstallDisplayIcon={app}\Ardia.ico
UninstallDisplayName=Ardia
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#Icon}"; DestDir: "{app}"; DestName: "Ardia.ico"; Flags: ignoreversion
#ifdef ShellManifest
Source: "{#ShellManifest}"; DestDir: "{app}"; DestName: "ardia-{#Shell}-files.txt"; Flags: ignoreversion
#endif
#ifdef RetiredList
Source: "{#RetiredList}"; DestName: "retired-shell.txt"; Flags: dontcopy
#endif
#ifdef KeptList
Source: "{#KeptList}"; DestName: "kept-files.txt"; Flags: dontcopy
#endif

[UninstallDelete]
Type: files; Name: "{app}\debug.log"
Type: dirifempty; Name: "{app}"

[Registry]
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM"; ValueType: string; ValueName: ""; ValueData: "Ardia HTML Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Ardia.Browser"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "ApplicationCompany"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\Application"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Ardia.Browser"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Classes\ArdiaHTM\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Ardia.exe""{#OpenSuffix} --single-argument %1"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia"; ValueType: string; ValueName: ""; ValueData: "Ardia"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".htm"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".html"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".shtml"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".svg"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".webp"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".xht"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\FileAssociations"; ValueType: string; ValueName: ".xhtml"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\StartMenu"; ValueType: string; ValueName: "StartMenuInternet"; ValueData: "Ardia"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\URLAssociations"; ValueType: string; ValueName: "http"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\Capabilities\URLAssociations"; ValueType: string; ValueName: "https"; ValueData: "ArdiaHTM"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Ardia.exe,0"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Ardia\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Ardia.exe""{#OpenSuffix}"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Ardia"; ValueData: "Software\Clients\StartMenuInternet\Ardia\Capabilities"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.shtml\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.svg\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.webp\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.xht\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.xhtml\OpenWithProgids"; ValueType: string; ValueName: "ArdiaHTM"; ValueData: ""; Flags: uninsdeletevalue

[Icons]
Name: "{autoprograms}\Ardia"; Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; IconFilename: "{app}\Ardia.ico"; AppUserModelID: "Ardia.Browser"
Name: "{autodesktop}\Ardia"; Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; IconFilename: "{app}\Ardia.ico"; AppUserModelID: "Ardia.Browser"; Tasks: desktopicon

[Run]
Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; Description: "Open Ardia"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Ardia.exe"; Parameters: "{#LaunchSwitch}"; Flags: nowait skipifnotsilent; Check: RelaunchAsked

[Code]
function CreateFile(Name: String; Access, Share, Security, Disposition, Flags, Template: Cardinal): Cardinal;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(Handle: Cardinal): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function RelaunchAsked: Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;

function InUse(Path: String): Boolean;
var
  Handle: Cardinal;
begin
  Result := False;
  if not FileExists(Path) then Exit;
  Handle := CreateFile(Path, $40000000, 0, 0, 3, $80, 0);
  if Handle = $FFFFFFFF then
    Result := True
  else
    CloseHandle(Handle);
end;

function AppInUse: Boolean;
begin
  Result := InUse(ExpandConstant('{app}\Ardia.exe')) or InUse(ExpandConstant('{app}\chrome.dll')) or InUse(ExpandConstant('{app}\ArdiaApp.dll'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Waited: Integer;
begin
  Result := '';
  if not RelaunchAsked then Exit;
  Waited := 0;
  while AppInUse and (Waited < 30000) do
  begin
    Sleep(250);
    Waited := Waited + 250;
  end;
end;

const
  LoginItemsKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  LoginApprovalsKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run';

function LaunchesThisArdia(Command: String): Boolean;
var
  Exe, Rest, Next: String;
begin
  Result := False;
  Exe := ExpandConstant('{app}\Ardia.exe');
  Command := Trim(Command);
  if CompareText(Copy(Command, 1, Length(Exe) + 2), '"' + Exe + '"') = 0 then
    Rest := Copy(Command, Length(Exe) + 3, Length(Command))
  else if CompareText(Copy(Command, 1, Length(Exe)), Exe) = 0 then
    Rest := Copy(Command, Length(Exe) + 1, Length(Command))
  else
    Exit;
  Next := Copy(Rest, 1, 1);
  if (Next <> '') and (Next <> ' ') and (Next <> #9) then Exit;
  Rest := Trim(Rest);
  Result := (Rest = '') or (CompareText(Rest, '--ardia-shell=webui') = 0) or (CompareText(Rest, '--ardia-shell=rnw') = 0);
end;

function LoginItemLaunchesThisArdia(Name: String): Boolean;
var
  Command: String;
begin
  Result := RegQueryStringValue(HKCU, LoginItemsKey, Name, Command) and LaunchesThisArdia(Command);
end;

function WriteLoginItem(Name: String): Boolean;
var
  Command, Wanted: String;
begin
  Wanted := '"' + ExpandConstant('{app}\Ardia.exe') + '"{#OpenSuffix}';
  Result := RegQueryStringValue(HKCU, LoginItemsKey, Name, Command) and (Command = Wanted);
  if Result then Exit;
  Result := RegWriteStringValue(HKCU, LoginItemsKey, Name, Wanted);
  if Result then
    Log('Login item ' + Name + ': now ' + Wanted)
  else
    Log('Login item ' + Name + ': could not be written');
end;

function CarryLoginItemApproval(DestExisted: Boolean): Boolean;
var
  Approval: AnsiString;
begin
  Result := True;
  if DestExisted then Exit;
  if RegValueExists(HKCU, LoginApprovalsKey, '{#RetiredLoginItemName}') then
  begin
    Result := RegQueryBinaryValue(HKCU, LoginApprovalsKey, '{#RetiredLoginItemName}', Approval);
    if Result then
      Result := RegWriteBinaryValue(HKCU, LoginApprovalsKey, '{#LoginItemName}', Approval);
  end
  else if RegValueExists(HKCU, LoginApprovalsKey, '{#LoginItemName}') then
    Result := RegDeleteValue(HKCU, LoginApprovalsKey, '{#LoginItemName}');
  if not Result then
    Log('Login item {#LoginItemName}: its approval could not be carried over, so {#RetiredLoginItemName} stays');
end;

procedure MoveLoginItem(DestExisted: Boolean);
begin
  if not CarryLoginItemApproval(DestExisted) then
  begin
    WriteLoginItem('{#RetiredLoginItemName}');
    Exit;
  end;
  if not WriteLoginItem('{#LoginItemName}') then
  begin
    WriteLoginItem('{#RetiredLoginItemName}');
    Exit;
  end;
  if RegDeleteValue(HKCU, LoginItemsKey, '{#RetiredLoginItemName}') then
  begin
    RegDeleteValue(HKCU, LoginApprovalsKey, '{#RetiredLoginItemName}');
    Log('Login item {#RetiredLoginItemName}: moved to {#LoginItemName}');
  end;
end;

procedure UpdateLoginItems;
var
  DestExisted: Boolean;
begin
  DestExisted := RegValueExists(HKCU, LoginItemsKey, '{#LoginItemName}');
  if LoginItemLaunchesThisArdia('{#RetiredLoginItemName}') then
  begin
    if DestExisted and not LoginItemLaunchesThisArdia('{#LoginItemName}') then
      WriteLoginItem('{#RetiredLoginItemName}')
    else
      MoveLoginItem(DestExisted);
  end
  else if LoginItemLaunchesThisArdia('{#LoginItemName}') then
    WriteLoginItem('{#LoginItemName}');
end;

#ifdef RetiredList
const
  InvalidFileAttributes = $FFFFFFFF;
  ReparsePointAttribute = $400;
  DirectoryAttribute = $10;

var
  RetiredShellFound: Boolean;
  PreviousOwnFound: Boolean;
  PreviousOwn: TArrayOfString;

function GetFileAttributes(Name: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function IsReparsePoint(Path: String): Boolean;
var
  Attributes: Cardinal;
begin
  Attributes := GetFileAttributes(Path);
  Result := (Attributes <> InvalidFileAttributes) and ((Attributes and ReparsePointAttribute) <> 0);
end;

function OwnedEntryValid(Entry: String): Boolean;
begin
  Result := (Entry <> '') and (Pos('..', Entry) = 0) and (Pos(':', Entry) = 0) and (Pos('/', Entry) = 0) and (Copy(Entry, 1, 1) <> '\') and (Copy(Entry, Length(Entry), 1) <> '\');
end;

function ExactEntryValid(Entry: String): Boolean;
begin
  Result := OwnedEntryValid(Entry) and (Pos('*', Entry) = 0) and (Pos('?', Entry) = 0);
end;

function PathWithoutLinks(Folder, Relative: String): Boolean;
var
  Rest, Path: String;
  Slash: Integer;
begin
  Result := False;
  if IsReparsePoint(Folder) then Exit;
  Path := Folder;
  Rest := Relative;
  Slash := Pos('\', Rest);
  while Slash > 0 do
  begin
    Path := Path + '\' + Copy(Rest, 1, Slash - 1);
    if IsReparsePoint(Path) then Exit;
    Rest := Copy(Rest, Slash + 1, Length(Rest) - Slash);
    Slash := Pos('\', Rest);
  end;
  Result := not IsReparsePoint(Path + '\' + Rest);
end;

function InList(List: TStringList; Entry: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 0 to List.Count - 1 do
    if CompareText(List[I], Entry) = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

procedure RemoveOwnedFile(Folder, Relative: String; Removed, Failed: TStringList);
var
  Path: String;
begin
  Path := Folder + '\' + Relative;
  if not PathWithoutLinks(Folder, Relative) then
  begin
    Log('Owned files: ' + Path + ' is behind a link, so it stays');
    Failed.Add(Relative);
    Exit;
  end;
  if not FileExists(Path) then Exit;
  if DeleteFile(Path) then
    Removed.Add(Path)
  else
  begin
    Log('Owned files: could not remove ' + Path);
    Failed.Add(Relative);
  end;
end;

procedure RemoveEmptyFolders(Folder: String; Removed: TStringList);
var
  Dir, Relative: String;
  I: Integer;
begin
  for I := 0 to Removed.Count - 1 do
  begin
    Dir := ExtractFileDir(Removed[I]);
    while (Length(Dir) > Length(Folder)) and (CompareText(Copy(Dir, 1, Length(Folder) + 1), Folder + '\') = 0) do
    begin
      Relative := Copy(Dir, Length(Folder) + 2, Length(Dir) - Length(Folder) - 1);
      if not PathWithoutLinks(Folder, Relative) then Break;
      if not RemoveDir(Dir) then Break;
      Dir := ExtractFileDir(Dir);
    end;
  end;
end;

procedure RemoveInEachFolder(Folder, Name: String; Removed, Failed: TStringList);
var
  Found: TFindRec;
begin
  if not ExactEntryValid(Name) or (Pos('\', Name) > 0) then Exit;
  if not FindFirst(Folder + '\*', Found) then Exit;
  try
    repeat
      if ((Found.Attributes and DirectoryAttribute) <> 0) and (Found.Name <> '.') and (Found.Name <> '..') then
        RemoveOwnedFile(Folder, Found.Name + '\' + Name, Removed, Failed);
    until not FindNext(Found);
  finally
    FindClose(Found);
  end;
end;

function ReadManifest(Folder, Name: String; var Entries: TArrayOfString): Boolean;
begin
  Result := False;
  if not FileExists(Folder + '\' + Name) then Exit;
  if not PathWithoutLinks(Folder, Name) then
  begin
    Log('Owned files: ' + Name + ' is behind a link, so it is not read');
    Exit;
  end;
  Result := LoadStringsFromFile(Folder + '\' + Name, Entries);
end;

procedure KeepOwnership(Path: String; Failed: TStringList);
var
  I: Integer;
begin
  for I := 0 to Failed.Count - 1 do
    if not SaveStringToFile(Path, Failed[I] + #13#10, True) then
      Log('Owned files: could not keep ' + Failed[I] + ' in ' + Path);
end;

procedure ReadKeptFiles(Kept: TStringList);
var
  Entries: TArrayOfString;
  I: Integer;
begin
#ifdef KeptList
  if not FileExists(ExpandConstant('{tmp}\kept-files.txt')) then
    ExtractTemporaryFile('kept-files.txt');
  if not LoadStringsFromFile(ExpandConstant('{tmp}\kept-files.txt'), Entries) then
  begin
    Log('Retired shell: the list of files both shells keep could not be read');
    Exit;
  end;
  for I := 0 to GetArrayLength(Entries) - 1 do
    if Trim(Entries[I]) <> '' then
      Kept.Add(Trim(Entries[I]));
#endif
end;

procedure RemoveRetiredShell(Folder: String);
var
  Manifest, Entry: String;
  Entries: TArrayOfString;
  Removed, Failed, Kept: TStringList;
  FromManifest: Boolean;
  I: Integer;
begin
  if not RetiredShellFound then Exit;
  Manifest := 'ardia-{#RetiredShell}-files.txt';
  FromManifest := FileExists(Folder + '\' + Manifest);
  if FromManifest then
  begin
    if not ReadManifest(Folder, Manifest, Entries) then
    begin
      Log('Retired shell: ' + Manifest + ' could not be read safely, so the other shell''s files stay');
      Exit;
    end;
  end
  else
  begin
    ExtractTemporaryFile('retired-shell.txt');
    if not LoadStringsFromFile(ExpandConstant('{tmp}\retired-shell.txt'), Entries) then
    begin
      Log('Retired shell: the list of the other shell''s files could not be read');
      Exit;
    end;
  end;
  Removed := TStringList.Create;
  Failed := TStringList.Create;
  Kept := TStringList.Create;
  try
    ReadKeptFiles(Kept);
    for I := 0 to GetArrayLength(Entries) - 1 do
    begin
      Entry := Trim(Entries[I]);
      if InList(Kept, Entry) then
        Log('Retired shell: ' + Entry + ' is kept by both shells, so it stays')
      else if ExactEntryValid(Entry) then
        RemoveOwnedFile(Folder, Entry, Removed, Failed)
      else if not FromManifest and OwnedEntryValid(Entry) and (Copy(Entry, 1, 2) = '*\') then
        RemoveInEachFolder(Folder, Copy(Entry, 3, Length(Entry) - 2), Removed, Failed)
      else if Entry <> '' then
        Log('Retired shell: ignored the entry ' + Entry);
    end;
    RemoveEmptyFolders(Folder, Removed);
    if FromManifest and PathWithoutLinks(Folder, Manifest) then
    begin
      if Failed.Count = 0 then
      begin
        if not DeleteFile(Folder + '\' + Manifest) then
          Log('Retired shell: could not remove ' + Manifest);
      end
      else if not SaveStringToFile(Folder + '\' + Manifest, '', False) then
        Log('Retired shell: could not rewrite ' + Manifest)
      else
        KeepOwnership(Folder + '\' + Manifest, Failed);
    end;
  finally
    Removed.Free;
    Failed.Free;
    Kept.Free;
  end;
end;

procedure RemoveStaleOwnFiles(Folder: String);
var
  Manifest, Entry: String;
  Current: TArrayOfString;
  Kept, Removed, Failed: TStringList;
  I: Integer;
begin
  if not PreviousOwnFound then Exit;
  Manifest := 'ardia-{#Shell}-files.txt';
  if not ReadManifest(Folder, Manifest, Current) then
  begin
    Log('Own files: the new ' + Manifest + ' could not be read safely, so files the last build shipped stay');
    Exit;
  end;
  Kept := TStringList.Create;
  Removed := TStringList.Create;
  Failed := TStringList.Create;
  try
    for I := 0 to GetArrayLength(Current) - 1 do
      Kept.Add(Trim(Current[I]));
    ReadKeptFiles(Kept);
    for I := 0 to GetArrayLength(PreviousOwn) - 1 do
    begin
      Entry := Trim(PreviousOwn[I]);
      if ExactEntryValid(Entry) and not InList(Kept, Entry) then
        RemoveOwnedFile(Folder, Entry, Removed, Failed);
    end;
    RemoveEmptyFolders(Folder, Removed);
    KeepOwnership(Folder + '\' + Manifest, Failed);
  finally
    Kept.Free;
    Removed.Free;
    Failed.Free;
  end;
end;

procedure NoteInstalledShells;
var
  Folder: String;
begin
  Folder := ExpandConstant('{app}');
  RetiredShellFound := FileExists(Folder + '\{#RetiredMarker}') or FileExists(Folder + '\ardia-{#RetiredShell}-files.txt');
  PreviousOwnFound := ReadManifest(Folder, 'ardia-{#Shell}-files.txt', PreviousOwn);
end;

procedure RemoveFilesNoLongerShipped;
var
  Folder: String;
begin
  Folder := ExpandConstant('{app}');
  if not FileExists(Folder + '\{#ShellMarker}') then
  begin
    Log('Owned files: {#ShellMarker} is not installed, so no file is removed');
    Exit;
  end;
  if IsReparsePoint(Folder) then
  begin
    Log('Owned files: ' + Folder + ' is a link, so no file is removed');
    Exit;
  end;
  RemoveStaleOwnFiles(Folder);
  RemoveRetiredShell(Folder);
end;

#endif

procedure CurStepChanged(CurStep: TSetupStep);
begin
#ifdef RetiredList
  if CurStep = ssInstall then
    NoteInstalledShells
  else if CurStep = ssPostInstall then
    RemoveFilesNoLongerShipped;
#endif
  if CurStep = ssPostInstall then
    UpdateLoginItems;
end;
