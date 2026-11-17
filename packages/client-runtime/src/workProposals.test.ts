import { describe, expect, it } from 'vitest'
import { workProposalAttachmentCount, workProposalAttachmentLine } from './workProposals'

describe('a proposal attachment line', () => {
  it('counts pictures alone without their names, whatever they are called', () => {
    expect(workProposalAttachmentLine({ attachments: ['pasted-image.jpg', 'image', 'Shot.PNG'], attachmentsAllImages: true })).toBe('3 images')
    expect(workProposalAttachmentLine({ attachments: ['image'], attachmentsAllImages: true })).toBe('1 image')
  })

  it('names the files once anything else goes along', () => {
    expect(workProposalAttachmentLine({ attachments: ['mockup.html', 'screen.png'] })).toBe('2 attachments: mockup.html, screen.png')
    expect(workProposalAttachmentLine({ attachments: [] })).toBeUndefined()
  })

  it('counts them without names for the phone', () => {
    expect(workProposalAttachmentCount({ attachments: ['image'], attachmentsAllImages: true })).toBe('1 image')
    expect(workProposalAttachmentCount({ attachments: ['mockup.html', 'screen.png'] })).toBe('2 attachments')
    expect(workProposalAttachmentCount({})).toBeUndefined()
  })
})
