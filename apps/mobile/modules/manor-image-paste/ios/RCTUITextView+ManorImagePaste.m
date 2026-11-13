#import <React/RCTUITextView.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static BOOL ManorComposerImagePasteEnabled = NO;
static NSString *const ManorPasteEnabledNotification = @"ManorComposerImagePasteEnabled";
static NSString *const ManorImagePastedNotification = @"ManorComposerImagePasted";
static NSUInteger const ManorImageDataURLLimit = 2000000;

static UIImage *ManorResizeImage(UIImage *image, CGFloat longestEdge)
{
  CGImageRef source = image.CGImage;
  if (source == nil) {
    return nil;
  }

  CGFloat width = (CGFloat)CGImageGetWidth(source);
  CGFloat height = (CGFloat)CGImageGetHeight(source);
  CGFloat scale = MIN(1, longestEdge / MAX(width, height));
  CGSize size = CGSizeMake(floor(width * scale), floor(height * scale));
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  format.opaque = YES;
  format.scale = 1;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    [[UIColor whiteColor] setFill];
    [context fillRect:CGRectMake(0, 0, size.width, size.height)];
    [image drawInRect:CGRectMake(0, 0, size.width, size.height)];
  }];
}

static NSString *ManorImageDataURL(UIImage *image)
{
  NSArray<NSNumber *> *edges = @[@1600, @1200, @900, @640];
  for (NSNumber *edge in edges) {
    UIImage *resized = ManorResizeImage(image, edge.doubleValue);
    NSData *data = resized == nil ? nil : UIImageJPEGRepresentation(resized, 0.72);
    if (data == nil) {
      continue;
    }
    NSString *base64 = [data base64EncodedStringWithOptions:0];
    NSString *dataURL = [@"data:image/jpeg;base64," stringByAppendingString:base64];
    if (dataURL.length <= ManorImageDataURLLimit) {
      return dataURL;
    }
  }
  return nil;
}

@interface RCTUITextView (ManorImagePaste)
@end

@implementation RCTUITextView (ManorImagePaste)

+ (void)load
{
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Method paste = class_getInstanceMethod(self, @selector(paste:));
    Method manorPaste = class_getInstanceMethod(self, @selector(manor_paste:));
    method_exchangeImplementations(paste, manorPaste);

    Method canPerform = class_getInstanceMethod(self, @selector(canPerformAction:withSender:));
    Method manorCanPerform = class_getInstanceMethod(self, @selector(manor_canPerformAction:withSender:));
    method_exchangeImplementations(canPerform, manorCanPerform);

    [[NSNotificationCenter defaultCenter]
      addObserverForName:ManorPasteEnabledNotification
      object:nil
      queue:[NSOperationQueue mainQueue]
      usingBlock:^(NSNotification *notification) {
        ManorComposerImagePasteEnabled = [notification.object boolValue];
      }];
  });
}

- (BOOL)manor_canPerformAction:(SEL)action withSender:(id)sender
{
  if (action == @selector(paste:) &&
      ManorComposerImagePasteEnabled &&
      UIPasteboard.generalPasteboard.hasImages) {
    return YES;
  }
  return [self manor_canPerformAction:action withSender:sender];
}

- (void)manor_paste:(id)sender
{
  UIImage *image = ManorComposerImagePasteEnabled ? UIPasteboard.generalPasteboard.image : nil;
  if (image == nil) {
    [self manor_paste:sender];
    return;
  }

  NSString *dataURL = ManorImageDataURL(image);
  NSDictionary<NSString *, NSString *> *payload = dataURL == nil
    ? @{ @"error": @"too_large" }
    : @{ @"name": @"pasted-image.jpg", @"dataUrl": dataURL };
  [[NSNotificationCenter defaultCenter]
    postNotificationName:ManorImagePastedNotification
    object:nil
    userInfo:payload];
}

@end
