// ===================================================================================
// ALL SET MODAL — the payoff screen shown once, right after email verification
// succeeds. Portal-rendered to document.body: CallContent (its trigger point) sits
// deep inside Fishtank's 3D transform tree (transform-style: preserve-3d, rotateX/
// rotateY on several ancestors), and a CSS-transformed ancestor creates a new
// containing block for position:fixed descendants - so a naively-nested fixed modal
// here would get clipped/mispositioned inside the tank's 3D box instead of covering
// the viewport. The portal escapes that.
// ===================================================================================

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mail, CheckCircle2, MessageCircle, X as CloseIcon } from 'lucide-react';
import { optIntoNewsletter } from '../tank-pick-client';
import './AllSetModal.css';

const TWITTER_URL = 'https://x.com/heatchecksio';
const DISCORD_URL = 'https://discord.gg/mF2NB6BNU';

const SPARKLE_COLORS = ['#ffc72c', '#fb923c', '#ff8a3d', '#e8a800', '#2fe6d9'];
const SPARKLE_COUNT = 10;

const Sparkleburst: React.FC = () => (
  <div className="allset-sparkles" aria-hidden="true">
    {Array.from({ length: SPARKLE_COUNT }).map((_, i) => {
      const angle = (360 / SPARKLE_COUNT) * i;
      const distance = 70 + (i % 3) * 18;
      const color = SPARKLE_COLORS[i % SPARKLE_COLORS.length];
      const size = 5 + (i % 3) * 3;
      const delay = (i % 5) * 0.08;
      return (
        <span
          key={i}
          className="allset-sparkle"
          style={{
            '--angle': `${angle}deg`,
            '--distance': `${distance}px`,
            '--size': `${size}px`,
            '--delay': `${delay}s`,
            background: color,
            boxShadow: `0 0 ${size * 1.5}px ${size * 0.5}px ${color}`,
          }}
        />
      );
    })}
  </div>
);

type SubscribeState = 'idle' | 'subscribing' | 'subscribed' | 'error';

export interface AllSetModalProps {
  email: string;
  onClose: () => void;
}

export const AllSetModal: React.FC<AllSetModalProps> = ({ email, onClose }) => {
  const [subscribeState, setSubscribeState] = useState<SubscribeState>('idle');

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const handleSubscribe = async () => {
    setSubscribeState('subscribing');
    try {
      await optIntoNewsletter(email);
      setSubscribeState('subscribed');
    } catch {
      setSubscribeState('error');
    }
  };

  return createPortal(
    <div className="allset-modal-overlay" onClick={onClose}>
      <div
        className="allset-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="You're all set"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="allset-modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={20} />
        </button>

        <div className="allset-modal-hero">
          <Sparkleburst />
          <img
            className="allset-modal-puppy"
            src="/assets/images/mudpuppy-default.webp"
            alt=""
            width={120}
            height={180}
          />
          <h2 className="allset-modal-headline">You're all set!</h2>
          <p className="allset-modal-twist">But wait&hellip; before you go.</p>
        </div>

        <div className="allset-modal-newsletter">
          <div className="allset-modal-newsletter-icon">
            <Mail size={20} />
          </div>
          <div className="allset-modal-newsletter-body">
            <h3>Get the newsletter</h3>
            <p>
              Weekly heat, early looks at new Tanks, and Ember drops hidden inside the
              newsletter itself &mdash; codes and challenges you won't find anywhere else.
            </p>
            {subscribeState === 'subscribed' ? (
              <div className="allset-modal-subscribed">
                <CheckCircle2 size={16} />
                <span>You're on the list, {email}</span>
              </div>
            ) : (
              <div className="allset-modal-subscribe-row">
                <span className="allset-modal-email-pill">{email}</span>
                <button
                  className="allset-modal-subscribe-btn"
                  onClick={handleSubscribe}
                  disabled={subscribeState === 'subscribing'}
                >
                  {subscribeState === 'subscribing' ? 'Subscribing…' : 'Subscribe'}
                </button>
              </div>
            )}
            {subscribeState === 'error' && (
              <p className="allset-modal-error">Couldn't subscribe just now. Try again.</p>
            )}
          </div>
        </div>

        <div className="allset-modal-social">
          <a
            className="allset-modal-social-link"
            href={TWITTER_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="allset-modal-social-icon allset-modal-social-icon--x">X</span>
            Follow on X
          </a>
          <a
            className="allset-modal-social-link"
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle size={18} />
            Join the Discord
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AllSetModal;
