import {
  Airplane01Icon,
  Analytics01Icon,
  Apple01Icon,
  ArchiveIcon,
  Attachment01Icon,
  Award01Icon,
  Backpack02Icon,
  BankIcon,
  BeachIcon,
  Bicycle01Icon,
  BirthdayCakeIcon,
  Book02Icon,
  Bookmark01Icon,
  Brain01Icon,
  Briefcase01Icon,
  Building03Icon,
  Calculator01Icon,
  Calendar03Icon,
  CallIcon,
  Camera01Icon,
  Car01Icon,
  CatIcon,
  Chat01Icon,
  CheckListIcon,
  Clock01Icon,
  CloudIcon,
  Coffee01Icon,
  Compass01Icon,
  ComputerIcon,
  ContactBookIcon,
  CrownIcon,
  DashboardSquare01Icon,
  Database01Icon,
  Download01Icon,
  Dumbbell01Icon,
  Edit01Icon,
  Factory01Icon,
  FavouriteIcon,
  File01Icon,
  FireIcon,
  Flag01Icon,
  FlowerIcon,
  Folder01Icon,
  GameController01Icon,
  GiftIcon,
  Globe02Icon,
  HealthIcon,
  Home01Icon,
  Idea01Icon,
  Key01Icon,
  LabsIcon,
  LanguageSkillIcon,
  LaptopIcon,
  LibraryIcon,
  Link01Icon,
  Location01Icon,
  LockIcon,
  Mail01Icon,
  MapsIcon,
  Medal01Icon,
  MeetingRoomIcon,
  Mic01Icon,
  MicroscopeIcon,
  Money01Icon,
  MountainIcon,
  MusicNote01Icon,
  News01Icon,
  PaintBrush01Icon,
  Plant01Icon,
  PuzzleIcon,
  Restaurant01Icon,
  Robot01Icon,
  Rocket01Icon,
  School01Icon,
  Search01Icon,
  SentIcon,
  Settings01Icon,
  Shield01Icon,
  ShoppingBag01Icon,
  SmartPhone01Icon,
  SourceCodeIcon,
  StarIcon,
  Store01Icon,
  Sun01Icon,
  Target01Icon,
  Task01Icon,
  Telescope01Icon,
  ToolsIcon,
  Train01Icon,
  Tree01Icon,
  TruckIcon,
  UmbrellaIcon,
  Upload01Icon,
  UserGroupIcon,
  UserIcon,
  Video01Icon,
  Wallet01Icon,
  Watch01Icon,
  Wifi01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'
import { DEFAULT_PROJECT_COLOR, type ProjectIcon } from '@manor/contracts'

/**
 * The picker is deliberately broad but finite. These cover the kinds of rooms Manor
 * holds without loading HugeIcons' entire catalogue or exposing provider names on the wire.
 */
export const PROJECT_ICON_OPTIONS: readonly {
  value: ProjectIcon
  label: string
  icon: typeof Folder01Icon
}[] = [
  { value: 'folder', label: 'Folder', icon: Folder01Icon },
  { value: 'home', label: 'Home', icon: Home01Icon },
  { value: 'briefcase', label: 'Work', icon: Briefcase01Icon },
  { value: 'book', label: 'Reading', icon: Book02Icon },
  { value: 'idea', label: 'Ideas', icon: Idea01Icon },
  { value: 'code', label: 'Code', icon: SourceCodeIcon },
  { value: 'calendar', label: 'Planning', icon: Calendar03Icon },
  { value: 'plane', label: 'Travel', icon: Airplane01Icon },
  { value: 'heart', label: 'Personal', icon: FavouriteIcon },
  { value: 'money', label: 'Money', icon: Money01Icon },
  { value: 'camera', label: 'Photography', icon: Camera01Icon },
  { value: 'rocket', label: 'Launch', icon: Rocket01Icon },
  { value: 'archive', label: 'Archive', icon: ArchiveIcon },
  { value: 'attachment', label: 'Attachment', icon: Attachment01Icon },
  { value: 'backpack', label: 'Backpack', icon: Backpack02Icon },
  { value: 'bank', label: 'Bank', icon: BankIcon },
  { value: 'bicycle', label: 'Cycling', icon: Bicycle01Icon },
  { value: 'birthday', label: 'Birthday', icon: BirthdayCakeIcon },
  { value: 'bookmark', label: 'Bookmark', icon: Bookmark01Icon },
  { value: 'brain', label: 'Thinking', icon: Brain01Icon },
  { value: 'building', label: 'Building', icon: Building03Icon },
  { value: 'calculator', label: 'Calculate', icon: Calculator01Icon },
  { value: 'call', label: 'Phone call', icon: CallIcon },
  { value: 'car', label: 'Driving', icon: Car01Icon },
  { value: 'chat', label: 'Conversation', icon: Chat01Icon },
  { value: 'checklist', label: 'Checklist', icon: CheckListIcon },
  { value: 'clock', label: 'Time', icon: Clock01Icon },
  { value: 'cloud', label: 'Cloud', icon: CloudIcon },
  { value: 'coffee', label: 'Coffee', icon: Coffee01Icon },
  { value: 'compass', label: 'Direction', icon: Compass01Icon },
  { value: 'computer', label: 'Desktop', icon: ComputerIcon },
  { value: 'contacts', label: 'Contacts', icon: ContactBookIcon },
  { value: 'crown', label: 'Crown', icon: CrownIcon },
  { value: 'dashboard', label: 'Dashboard', icon: DashboardSquare01Icon },
  { value: 'database', label: 'Database', icon: Database01Icon },
  { value: 'document', label: 'Document', icon: File01Icon },
  { value: 'download', label: 'Download', icon: Download01Icon },
  { value: 'edit', label: 'Edit', icon: Edit01Icon },
  { value: 'factory', label: 'Factory', icon: Factory01Icon },
  { value: 'fire', label: 'Fire', icon: FireIcon },
  { value: 'flag', label: 'Flag', icon: Flag01Icon },
  { value: 'flower', label: 'Garden', icon: FlowerIcon },
  { value: 'game', label: 'Gaming', icon: GameController01Icon },
  { value: 'gift', label: 'Gift', icon: GiftIcon },
  { value: 'globe', label: 'World', icon: Globe02Icon },
  { value: 'gym', label: 'Fitness', icon: Dumbbell01Icon },
  { value: 'key', label: 'Key', icon: Key01Icon },
  { value: 'lab', label: 'Research', icon: LabsIcon },
  { value: 'language', label: 'Language', icon: LanguageSkillIcon },
  { value: 'laptop', label: 'Laptop', icon: LaptopIcon },
  { value: 'library', label: 'Library', icon: LibraryIcon },
  { value: 'link', label: 'Link', icon: Link01Icon },
  { value: 'location', label: 'Place', icon: Location01Icon },
  { value: 'lock', label: 'Private', icon: LockIcon },
  { value: 'mail', label: 'Email', icon: Mail01Icon },
  { value: 'map', label: 'Map', icon: MapsIcon },
  { value: 'medal', label: 'Achievement', icon: Medal01Icon },
  { value: 'meeting', label: 'Meeting', icon: MeetingRoomIcon },
  { value: 'microphone', label: 'Audio', icon: Mic01Icon },
  { value: 'microscope', label: 'Science', icon: MicroscopeIcon },
  { value: 'mountain', label: 'Outdoors', icon: MountainIcon },
  { value: 'music', label: 'Music', icon: MusicNote01Icon },
  { value: 'news', label: 'News', icon: News01Icon },
  { value: 'paint', label: 'Art', icon: PaintBrush01Icon },
  { value: 'phone', label: 'Mobile', icon: SmartPhone01Icon },
  { value: 'plant', label: 'Plants', icon: Plant01Icon },
  { value: 'puzzle', label: 'Puzzle', icon: PuzzleIcon },
  { value: 'restaurant', label: 'Restaurant', icon: Restaurant01Icon },
  { value: 'robot', label: 'Robot', icon: Robot01Icon },
  { value: 'school', label: 'Education', icon: School01Icon },
  { value: 'search', label: 'Search', icon: Search01Icon },
  { value: 'send', label: 'Send', icon: SentIcon },
  { value: 'settings', label: 'Settings', icon: Settings01Icon },
  { value: 'shield', label: 'Security', icon: Shield01Icon },
  { value: 'shopping', label: 'Shopping', icon: ShoppingBag01Icon },
  { value: 'star', label: 'Favourite', icon: StarIcon },
  { value: 'store', label: 'Store', icon: Store01Icon },
  { value: 'sun', label: 'Weather', icon: Sun01Icon },
  { value: 'target', label: 'Goal', icon: Target01Icon },
  { value: 'task', label: 'Tasks', icon: Task01Icon },
  { value: 'team', label: 'Team', icon: UserGroupIcon },
  { value: 'telescope', label: 'Explore', icon: Telescope01Icon },
  { value: 'tools', label: 'Tools', icon: ToolsIcon },
  { value: 'train', label: 'Train', icon: Train01Icon },
  { value: 'truck', label: 'Delivery', icon: TruckIcon },
  { value: 'umbrella', label: 'Umbrella', icon: UmbrellaIcon },
  { value: 'upload', label: 'Upload', icon: Upload01Icon },
  { value: 'user', label: 'Person', icon: UserIcon },
  { value: 'video', label: 'Video', icon: Video01Icon },
  { value: 'wallet', label: 'Wallet', icon: Wallet01Icon },
  { value: 'watch', label: 'Watch', icon: Watch01Icon },
  { value: 'wifi', label: 'WiFi', icon: Wifi01Icon },
  { value: 'wrench', label: 'Repair', icon: Wrench01Icon },
  { value: 'analytics', label: 'Analytics', icon: Analytics01Icon },
  { value: 'beach', label: 'Holiday', icon: BeachIcon },
  { value: 'cat', label: 'Cat', icon: CatIcon },
  { value: 'health', label: 'Health', icon: HealthIcon },
  { value: 'food', label: 'Nutrition', icon: Apple01Icon },
  { value: 'nature', label: 'Nature', icon: Tree01Icon },
  { value: 'award', label: 'Award', icon: Award01Icon },
]

const ICONS = Object.fromEntries(PROJECT_ICON_OPTIONS.map(({ value, icon }) => [value, icon])) as Record<
  ProjectIcon,
  typeof Folder01Icon
>

export const projectIcon = (icon: ProjectIcon) => ICONS[icon]

export interface ProjectColorOption {
  value: string
  label: string
}

/**
 * Fixed swatches, arranged in three rows of six in the identity picker. The
 * original persona hues stay available; the ten additional shades have at least
 * 3:1 contrast against the project surfaces in both themes. These are icon colours,
 * not text colours, and existing projects keep their saved colour. The Mac and the
 * phone both offer this set.
 */
export const PROJECT_COLOR_OPTIONS: readonly ProjectColorOption[] = [
  { value: DEFAULT_PROJECT_COLOR, label: 'Grey' },
  { value: '#E5817C', label: 'Red' },
  { value: '#D08A3E', label: 'Orange' },
  { value: '#E0AF68', label: 'Amber' },
  { value: '#9ECE6A', label: 'Green' },
  { value: '#7AA2F7', label: 'Blue' },
  { value: '#8B7EC8', label: 'Purple' },
  { value: '#C77DBB', label: 'Pink' },
  { value: '#388B83', label: 'Teal' },
  { value: '#388D63', label: 'Emerald' },
  { value: '#2889A0', label: 'Cyan' },
  { value: '#3984BD', label: 'Sky' },
  { value: '#777BC4', label: 'Indigo' },
  { value: '#A16ABD', label: 'Violet' },
  { value: '#BB6090', label: 'Raspberry' },
  { value: '#C46D57', label: 'Coral' },
  { value: '#82883B', label: 'Olive' },
  { value: '#A67C52', label: 'Brown' },
]

const sameColor = (one: string, other: string) => one.toLowerCase() === other.toLowerCase()

/** A six-digit hex for a saved colour, shorthand grown; anything else reads as the default. */
function savedHex(value: string): string {
  const clean = value.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(clean)
  const full = short === null ? clean : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return /^#[0-9a-f]{6}$/i.test(full) ? full : DEFAULT_PROJECT_COLOR
}

/**
 * The swatches offered to a project already wearing `color`. The set is fixed, and
 * a project holding a colour from before the set existed keeps its own on the end:
 * repainting a room because the palette moved is not the picker's call to make.
 */
export function projectColorChoices(color: string): readonly ProjectColorOption[] {
  const own = savedHex(color)
  if (PROJECT_COLOR_OPTIONS.some((option) => sameColor(option.value, own))) return PROJECT_COLOR_OPTIONS
  return [...PROJECT_COLOR_OPTIONS, { value: own, label: 'Its own colour' }]
}
